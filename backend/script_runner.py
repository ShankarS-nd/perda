"""
script_runner.py — Universal script discovery and execution engine.

Supports ANY Python script by auto-detecting arguments through multiple
strategies (in priority order):

  1. Explicit SCRIPT_ARGS declaration (list of dicts)
  2. argparse add_argument() calls parsed via AST
  3. Zero-arg fallback (script still runs with no form fields)

The runner also adapts how arguments are passed to scripts:

  • --key value   (argparse style, default)
  • positional    (sys.argv style, when SCRIPT_ARGS includes "positional": true)
"""

from __future__ import annotations

import ast
import json
import re
import select
import subprocess
import sys
import time as _time
from pathlib import Path
from typing import Any, Generator

from pydantic import BaseModel

from database import save_script_run

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPTS_DIR = Path(__file__).resolve().parent / "scripts"

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class ScriptArg(BaseModel):
    """A single argument expected by a script."""
    name: str
    type: str               # "string" | "int" | "float" | "bool"
    description: str = ""   # human-readable help text
    default: str = ""       # default value (always stringified)
    required: bool = True
    positional: bool = False  # if True, pass as positional arg (no --flag)


class ScriptInfo(BaseModel):
    """Metadata for a discoverable script."""
    name: str
    description: str = ""
    args: list[ScriptArg]
    cwd: str = ""            # working directory override (absolute path)
    outputs_dir: str = ""    # directory where output files are written


class RunScriptRequest(BaseModel):
    """Payload accepted by POST /run-script."""
    script: str
    args: dict[str, Any]


class RunScriptResponse(BaseModel):
    """Response returned after running a script."""
    stdout: str
    stderr: str
    return_code: int


# ---------------------------------------------------------------------------
# Strategy 1 — Parse SCRIPT_ARGS declaration
# ---------------------------------------------------------------------------


def _parse_script_args_decl(tree: ast.Module) -> list[ScriptArg] | None:
    """
    Look for a top-level ``SCRIPT_ARGS = [...]`` assignment and extract
    argument metadata from it.  Returns None if not found.
    """
    for node in ast.iter_child_nodes(tree):
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "SCRIPT_ARGS"
            and isinstance(node.value, ast.List)
        ):
            return _eval_args_list(node.value)
    return None


def _eval_args_list(list_node: ast.List) -> list[ScriptArg]:
    """Safely evaluate a list-of-dicts from the AST into ScriptArg objects."""
    args: list[ScriptArg] = []
    for elt in list_node.elts:
        if not isinstance(elt, ast.Dict):
            continue
        data: dict[str, Any] = {}
        for k, v in zip(elt.keys, elt.values):
            if not isinstance(k, ast.Constant):
                continue
            if isinstance(v, ast.Constant):
                data[k.value] = v.value
            elif isinstance(v, ast.NameConstant):  # Python 3.7 compat
                data[k.value] = v.value
        if "name" in data and "type" in data:
            args.append(ScriptArg(
                name=data["name"],
                type=data["type"],
                description=data.get("description", ""),
                default=str(data.get("default", "")),
                required=data.get("required", True),
                positional=data.get("positional", False),
            ))
    return args


# ---------------------------------------------------------------------------
# Strategy 2 — Parse argparse add_argument() calls
# ---------------------------------------------------------------------------

_TYPE_MAP = {"str": "string", "int": "int", "float": "float", "bool": "bool"}


def _parse_argparse_args(tree: ast.Module) -> list[ScriptArg] | None:
    """
    Walk the entire AST looking for calls like:
        parser.add_argument("--name", type=str, default="foo", help="...")
    Returns None if no add_argument calls are found.
    """
    args: list[ScriptArg] = []

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        # Match  *.add_argument(...)
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "add_argument"):
            continue
        if not node.args:
            continue

        # --- extract positional string (e.g. "--name" or "name") ---
        first_arg = node.args[0]
        if isinstance(first_arg, ast.Constant) and isinstance(first_arg.value, str):
            raw_name = first_arg.value
        else:
            continue

        is_positional = not raw_name.startswith("-")
        clean_name = raw_name.lstrip("-").replace("-", "_")

        # --- extract keyword arguments ---
        kw: dict[str, Any] = {}
        for keyword in node.keywords:
            if keyword.arg is None:
                continue
            val = keyword.value
            if isinstance(val, ast.Constant):
                kw[keyword.arg] = val.value
            elif isinstance(val, ast.Name):
                kw[keyword.arg] = val.id          # e.g. type=str → "str"
            elif isinstance(val, ast.Attribute):
                kw[keyword.arg] = val.attr

        arg_type = _TYPE_MAP.get(str(kw.get("type", "str")), "string")
        description = str(kw.get("help", ""))
        default_val = str(kw.get("default", ""))
        required = kw.get("required", is_positional)

        # action="store_true" / "store_false" → bool with no value needed
        action = kw.get("action", "")
        if action in ("store_true", "store_false"):
            arg_type = "bool"
            default_val = "false" if action == "store_true" else "true"

        args.append(ScriptArg(
            name=clean_name,
            type=arg_type,
            description=description,
            default=default_val if default_val != "None" else "",
            required=bool(required),
            positional=is_positional,
        ))

    return args if args else None


# ---------------------------------------------------------------------------
# Script-level description
# ---------------------------------------------------------------------------


def _extract_description(tree: ast.Module) -> str:
    """Return the module-level docstring, if any."""
    return ast.get_docstring(tree) or ""


def _extract_string_constant(tree: ast.Module, name: str) -> str:
    """Return the string value of a top-level ``NAME = "..."`` assignment."""
    for node in ast.iter_child_nodes(tree):
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == name
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            return node.value.value
    return ""


# ---------------------------------------------------------------------------
# Combined discovery
# ---------------------------------------------------------------------------


def _discover_script(filepath: Path) -> ScriptInfo | None:
    """
    Analyse a single script file and return its metadata.
    Tries SCRIPT_ARGS first, then argparse, then falls back to no-args.
    """
    try:
        source = filepath.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(filepath))
    except (SyntaxError, UnicodeDecodeError):
        return None

    description = _extract_description(tree)

    # Strategy 1
    args = _parse_script_args_decl(tree)

    # Strategy 2
    if args is None:
        args = _parse_argparse_args(tree)

    # Fallback
    if args is None:
        args = []

    # Resolve relative CWD / outputs paths relative to the script's directory
    raw_cwd = _extract_string_constant(tree, "SCRIPT_CWD")
    raw_outputs = _extract_string_constant(tree, "SCRIPT_OUTPUTS")
    script_dir = filepath.resolve().parent

    cwd = str((script_dir / raw_cwd).resolve()) if raw_cwd else ""
    outputs_dir = str((script_dir / raw_outputs).resolve()) if raw_outputs else ""

    return ScriptInfo(
        name=filepath.stem,
        description=description[:200],  # keep it short
        args=args,
        cwd=cwd,
        outputs_dir=outputs_dir,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_scripts() -> list[ScriptInfo]:
    """Discover every Python script in the ``scripts/`` directory."""
    scripts: list[ScriptInfo] = []

    if not SCRIPTS_DIR.is_dir():
        return scripts

    for path in sorted(SCRIPTS_DIR.glob("*.py")):
        if path.name.startswith("_"):
            continue
        info = _discover_script(path)
        if info is not None:
            scripts.append(info)

    return scripts


def _build_command(request: RunScriptRequest) -> tuple[list[str], dict[str, ScriptArg], int, str | None]:
    """
    Build the subprocess command list for a script request.

    Returns (cmd, arg_meta, exec_timeout, cwd).
    Raises FileNotFoundError if the script does not exist.
    """
    script_path = SCRIPTS_DIR / f"{request.script}.py"

    if not script_path.is_file():
        raise FileNotFoundError(f"Script '{request.script}' not found.")

    # Look up arg metadata so we know which are positional / bool
    info = _discover_script(script_path)
    arg_meta: dict[str, ScriptArg] = {}
    cwd: str | None = None
    if info:
        arg_meta = {a.name: a for a in info.args}
        if info.cwd:
            cwd = info.cwd

    # Build the command
    cmd: list[str] = [sys.executable, "-u", str(script_path)]  # -u = unbuffered
    positional_values: list[str] = []

    for key, value in request.args.items():
        meta = arg_meta.get(key)
        str_value = str(value)

        if meta and meta.positional:
            positional_values.append(str_value)
            continue

        if meta and meta.type == "bool":
            if str_value.lower() in ("true", "1", "yes"):
                cmd.append(f"--{key}")
            continue

        if str_value:
            cmd.extend([f"--{key}", str_value])

    cmd.extend(positional_values)

    # Derive timeout
    exec_timeout = 180
    if "timeout" in request.args:
        try:
            exec_timeout = int(request.args["timeout"]) + 10
        except (ValueError, TypeError):
            pass

    return cmd, arg_meta, exec_timeout, cwd


def run_script(request: RunScriptRequest) -> RunScriptResponse:
    """
    Execute a script with the given arguments (non-streaming).
    """
    start = _time.monotonic()

    try:
        cmd, _, exec_timeout, cwd = _build_command(request)
    except FileNotFoundError as e:
        elapsed = round(_time.monotonic() - start, 3)
        _save_run(request, "", str(e), "failed", elapsed)
        return RunScriptResponse(stdout="", stderr=str(e), return_code=1)

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=exec_timeout,
            cwd=cwd,
        )
        elapsed = round(_time.monotonic() - start, 3)
        status = "success" if result.returncode == 0 else "failed"
        _save_run(request, result.stdout, result.stderr, status, elapsed)
        return RunScriptResponse(
            stdout=result.stdout,
            stderr=result.stderr,
            return_code=result.returncode,
        )
    except subprocess.TimeoutExpired:
        elapsed = round(_time.monotonic() - start, 3)
        _save_run(request, "", f"Script execution timed out ({exec_timeout} s limit).", "failed", elapsed)
        return RunScriptResponse(
            stdout="",
            stderr=f"Script execution timed out ({exec_timeout} s limit).",
            return_code=124,
        )
    except Exception as exc:
        elapsed = round(_time.monotonic() - start, 3)
        _save_run(request, "", f"Failed to execute script: {exc}", "failed", elapsed)
        return RunScriptResponse(
            stdout="",
            stderr=f"Failed to execute script: {exc}",
            return_code=1,
        )


def stream_script(request: RunScriptRequest) -> Generator[str, None, None]:
    """
    Execute a script and yield Server-Sent Events line by line.

    SSE format:
      data: {"type": "stdout", "text": "line content"}\\n\\n
      data: {"type": "stderr", "text": "error line"}\\n\\n
      data: {"type": "exit",   "code": 0}\\n\\n
    """
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    start = _time.monotonic()
    exit_code = 1

    try:
        cmd, _, exec_timeout, cwd = _build_command(request)
    except FileNotFoundError as e:
        stderr_lines.append(str(e))
        yield f"data: {json.dumps({'type': 'stderr', 'text': str(e)})}\n\n"
        yield f"data: {json.dumps({'type': 'exit', 'code': 1})}\n\n"
        elapsed = round(_time.monotonic() - start, 3)
        _save_run(request, "", str(e), "failed", elapsed)
        return

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # line-buffered
            cwd=cwd,
        )
    except Exception as exc:
        stderr_lines.append(f"Failed to start: {exc}")
        yield f"data: {json.dumps({'type': 'stderr', 'text': f'Failed to start: {exc}'})}\n\n"
        yield f"data: {json.dumps({'type': 'exit', 'code': 1})}\n\n"
        elapsed = round(_time.monotonic() - start, 3)
        _save_run(request, "", f"Failed to start: {exc}", "failed", elapsed)
        return

    try:
        # Use select to read from both stdout and stderr without blocking
        stdout_fd = proc.stdout
        stderr_fd = proc.stderr
        streams = [stdout_fd, stderr_fd]
        stream_names = {id(stdout_fd): "stdout", id(stderr_fd): "stderr"}

        while streams:
            # Check timeout
            if _time.monotonic() - start > exec_timeout:
                proc.kill()
                stderr_lines.append(f"Timed out after {exec_timeout}s")
                yield f"data: {json.dumps({'type': 'stderr', 'text': f'Timed out after {exec_timeout}s'})}\n\n"
                break

            readable, _, _ = select.select(streams, [], [], 0.1)
            for stream in readable:
                line = stream.readline()
                if line:
                    text = line.rstrip("\n")
                    stype = stream_names[id(stream)]
                    if stype == "stdout":
                        stdout_lines.append(text)
                    else:
                        stderr_lines.append(text)
                    yield f"data: {json.dumps({'type': stype, 'text': text})}\n\n"
                else:
                    # EOF on this stream
                    streams.remove(stream)

        proc.wait(timeout=5)
        exit_code = proc.returncode or 0
    except Exception as exc:
        proc.kill()
        stderr_lines.append(f"Error: {exc}")
        yield f"data: {json.dumps({'type': 'stderr', 'text': f'Error: {exc}'})}\n\n"

    yield f"data: {json.dumps({'type': 'exit', 'code': exit_code})}\n\n"

    # Record to database after streaming completes
    elapsed = round(_time.monotonic() - start, 3)
    status = "success" if exit_code == 0 else "failed"
    _save_run(
        request,
        "\n".join(stdout_lines),
        "\n".join(stderr_lines),
        status,
        elapsed,
    )


def _save_run(
    request: RunScriptRequest,
    stdout: str,
    stderr: str,
    status: str,
    execution_time: float,
) -> None:
    """Persist a run record. Failures are silently ignored."""
    try:
        save_script_run(
            script_name=request.script,
            arguments=request.args,
            stdout=stdout,
            stderr=stderr,
            status=status,
            execution_time=execution_time,
        )
    except Exception:
        pass  # never let DB issues break script execution


def get_output_files(script_name: str) -> list[dict[str, str]]:
    """
    Return a list of output files for a script that declares SCRIPT_OUTPUTS.
    Each entry: {"name": "filename", "path": "/absolute/path/to/file"}
    """
    script_path = SCRIPTS_DIR / f"{script_name}.py"
    if not script_path.is_file():
        return []

    info = _discover_script(script_path)
    if not info or not info.outputs_dir:
        return []

    outputs_dir = Path(info.outputs_dir)
    if not outputs_dir.is_dir():
        return []

    files = []
    for f in sorted(outputs_dir.rglob("*")):
        if f.is_file():
            files.append({
                "name": str(f.relative_to(outputs_dir)),
                "path": str(f),
            })
    return files
