"""
workflow_engine.py — Workflow execution engine.

Responsibilities:
  • Parse a workflow definition (nodes + edges)
  • Determine execution order via topological traversal
  • Execute nodes sequentially with retry logic
  • Evaluate conditional edges (success / failure / always)
  • Resolve {{node_id.key}} placeholders between steps
  • Capture stdout, stderr, timing, and JSON outputs
  • Persist every step to the database
  • Stream progress via SSE
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time as _time
from pathlib import Path
from typing import Any, Generator

from database import (
    create_workflow_run,
    update_workflow_run,
    save_workflow_step,
    update_workflow_step,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPTS_DIR = Path(__file__).resolve().parent / "scripts"
PLACEHOLDER_RE = re.compile(r"\{\{(\w+)\.(\w+)\}\}")


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

class WorkflowNode:
    """A single node in a workflow graph."""

    def __init__(self, data: dict[str, Any]) -> None:
        self.id: str = data["id"]
        self.script: str = data.get("script", data.get("data", {}).get("script", ""))
        self.retry: int = int(data.get("retry", data.get("data", {}).get("retry", 0)))
        self.args: dict[str, Any] = data.get("args", data.get("data", {}).get("args", {}))


class WorkflowEdge:
    """A directed edge with a condition label."""

    def __init__(self, data: dict[str, Any]) -> None:
        self.source: str = data["source"]
        self.target: str = data["target"]
        self.condition: str = data.get("condition", data.get("data", {}).get("condition", "always"))


# ---------------------------------------------------------------------------
# Placeholder resolution
# ---------------------------------------------------------------------------


def _resolve_placeholders(value: Any, outputs: dict[str, dict[str, Any]]) -> Any:
    """
    Recursively replace ``{{node_id.key}}`` tokens in *value* using the
    collected *outputs* map.
    """
    if isinstance(value, str):
        def _replacer(m: re.Match) -> str:
            node_id, key = m.group(1), m.group(2)
            node_out = outputs.get(node_id, {})
            return str(node_out.get(key, m.group(0)))
        return PLACEHOLDER_RE.sub(_replacer, value)
    if isinstance(value, dict):
        return {k: _resolve_placeholders(v, outputs) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_placeholders(v, outputs) for v in value]
    return value


# ---------------------------------------------------------------------------
# Script execution (synchronous, used by engine)
# ---------------------------------------------------------------------------


def _discover_cwd(script_name: str) -> str | None:
    """Read SCRIPT_CWD from a script file if present."""
    script_path = SCRIPTS_DIR / f"{script_name}.py"
    if not script_path.is_file():
        return None
    try:
        import ast
        tree = ast.parse(script_path.read_text(encoding="utf-8"))
        for node in ast.iter_child_nodes(tree):
            if (
                isinstance(node, ast.Assign)
                and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == "SCRIPT_CWD"
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
            ):
                return str((script_path.parent / node.value.value).resolve())
    except Exception:
        pass
    return None


def _run_single_script(
    script_name: str,
    args: dict[str, Any],
    timeout: int = 180,
    on_stdout: Any = None,
    on_stderr: Any = None,
) -> dict[str, Any]:
    """
    Execute *script_name* with *args* and return a result dict:
      stdout, stderr, return_code, execution_time, output (parsed JSON or {})

    If *on_stdout* / *on_stderr* callbacks are given they are called with each
    line as it is produced, enabling the caller to stream output in real-time.
    """
    script_path = SCRIPTS_DIR / f"{script_name}.py"
    if not script_path.is_file():
        return {
            "stdout": "",
            "stderr": f"Script '{script_name}' not found.",
            "return_code": 1,
            "execution_time": 0.0,
            "output": {},
        }

    cmd: list[str] = [sys.executable, "-u", str(script_path)]
    for key, value in args.items():
        sv = str(value)
        if sv:
            cmd.extend([f"--{key}", sv])

    cwd = _discover_cwd(script_name)
    start = _time.monotonic()
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=cwd, bufsize=1,
        )

        import selectors
        sel = selectors.DefaultSelector()
        if proc.stdout:
            sel.register(proc.stdout, selectors.EVENT_READ)
        if proc.stderr:
            sel.register(proc.stderr, selectors.EVENT_READ)

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        deadline = _time.monotonic() + timeout

        while sel.get_map():
            remaining = deadline - _time.monotonic()
            if remaining <= 0:
                proc.kill()
                proc.wait()
                elapsed = round(_time.monotonic() - start, 3)
                return {
                    "stdout": "".join(stdout_lines),
                    "stderr": "".join(stderr_lines) + f"\nTimed out after {timeout}s",
                    "return_code": 124,
                    "execution_time": elapsed,
                    "output": {},
                }

            events = sel.select(timeout=min(remaining, 0.5))
            for key_obj, _ in events:
                line = key_obj.fileobj.readline()  # type: ignore[union-attr]
                if not line:
                    sel.unregister(key_obj.fileobj)
                    continue
                if key_obj.fileobj is proc.stdout:
                    stdout_lines.append(line)
                    if on_stdout:
                        on_stdout(line.rstrip("\n"))
                elif key_obj.fileobj is proc.stderr:
                    stderr_lines.append(line)
                    if on_stderr:
                        on_stderr(line.rstrip("\n"))

        proc.wait()
        elapsed = round(_time.monotonic() - start, 3)

        full_stdout = "".join(stdout_lines)
        full_stderr = "".join(stderr_lines)

        # Try to extract JSON from the last non-empty line of stdout
        parsed_output: dict[str, Any] = {}
        for raw_line in reversed(full_stdout.strip().splitlines()):
            raw_line = raw_line.strip()
            if raw_line.startswith("{"):
                try:
                    parsed_output = json.loads(raw_line)
                except json.JSONDecodeError:
                    pass
                break

        return {
            "stdout": full_stdout,
            "stderr": full_stderr,
            "return_code": proc.returncode,
            "execution_time": elapsed,
            "output": parsed_output,
        }
    except Exception as exc:
        elapsed = round(_time.monotonic() - start, 3)
        return {
            "stdout": "",
            "stderr": str(exc),
            "return_code": 1,
            "execution_time": elapsed,
            "output": {},
        }


# ---------------------------------------------------------------------------
# Engine — streaming execution
# ---------------------------------------------------------------------------


def run_workflow(
    workflow_id: int,
    definition: dict[str, Any],
) -> Generator[str, None, None]:
    """
    Execute a workflow and yield SSE events for each step.

    Event types:
      workflow_start  → {run_id}
      step_start      → {node_id, script_name}
      step_retry      → {node_id, attempt}
      step_complete   → {node_id, status, execution_time, stdout, stderr, output}
      step_skipped    → {node_id}
      workflow_end    → {run_id, status}
    """

    # -- Parse definition ---------------------------------------------------
    raw_nodes: list[dict[str, Any]] = definition.get("nodes", [])
    raw_edges: list[dict[str, Any]] = definition.get("edges", [])

    nodes: dict[str, WorkflowNode] = {}
    for rn in raw_nodes:
        n = WorkflowNode(rn)
        nodes[n.id] = n

    edges: list[WorkflowEdge] = [WorkflowEdge(e) for e in raw_edges]

    # -- Build adjacency (outgoing edges per node) --------------------------
    outgoing: dict[str, list[WorkflowEdge]] = {nid: [] for nid in nodes}
    incoming_set: set[str] = set()
    for e in edges:
        outgoing.setdefault(e.source, []).append(e)
        incoming_set.add(e.target)

    # -- Starting nodes = no incoming edges ---------------------------------
    start_nodes = [nid for nid in nodes if nid not in incoming_set]
    if not start_nodes:
        start_nodes = list(nodes.keys())[:1]  # fallback

    # -- Create DB run record -----------------------------------------------
    run_id = create_workflow_run(workflow_id)
    _emit = lambda etype, data: f"data: {json.dumps({'type': etype, **data})}\n\n"

    yield _emit("workflow_start", {"run_id": run_id})

    # -- Execution state ----------------------------------------------------
    outputs: dict[str, dict[str, Any]] = {}        # node_id → parsed JSON output
    script_to_node: dict[str, str] = {}             # script_name → node_id (for placeholder lookup)
    statuses: dict[str, str] = {}                    # node_id → success/failed/skipped
    step_ids: dict[str, int] = {}                    # node_id → DB step id

    # BFS/queue-based execution
    queue: list[str] = list(start_nodes)
    visited: set[str] = set()
    overall_status = "success"

    while queue:
        node_id = queue.pop(0)
        if node_id in visited:
            continue
        visited.add(node_id)

        node = nodes.get(node_id)
        if not node:
            continue

        # Create step record
        db_step_id = save_workflow_step(run_id, node_id, node.script, "running")
        step_ids[node_id] = db_step_id

        yield _emit("step_start", {"node_id": node_id, "script_name": node.script})

        # Track script_name → node_id mapping
        script_to_node[node.script] = node.id

        # Build a combined lookup so {{node_id.key}} and {{script_name.key}} both work
        combined_outputs: dict[str, dict[str, Any]] = {**outputs}
        for sname, nid in script_to_node.items():
            if nid in outputs:
                combined_outputs[sname] = outputs[nid]

        # Resolve placeholders in args
        resolved_args = _resolve_placeholders(node.args, combined_outputs)

        # Execute with retry logic
        max_attempts = max(node.retry, 0) + 1
        final_result: dict[str, Any] | None = None

        # We'll collect output lines in a thread-safe list and stream them
        # to the SSE client. _run_single_script runs in a thread (via
        # concurrent.futures) so we can pop lines from the main generator.
        import threading
        import queue as _queue

        line_queue: _queue.Queue[tuple[str, str]] = _queue.Queue()

        def _on_stdout(text: str) -> None:
            line_queue.put(("stdout", text))

        def _on_stderr(text: str) -> None:
            line_queue.put(("stderr", text))

        for attempt in range(1, max_attempts + 1):
            if attempt > 1:
                yield _emit("step_retry", {"node_id": node_id, "attempt": attempt})

            # Run script in a thread so we can yield SSE events from the generator
            result_holder: list[dict[str, Any]] = []
            done_event = threading.Event()

            def _run_in_thread() -> None:
                r = _run_single_script(
                    node.script, resolved_args,
                    on_stdout=_on_stdout, on_stderr=_on_stderr,
                )
                result_holder.append(r)
                done_event.set()

            t = threading.Thread(target=_run_in_thread, daemon=True)
            t.start()

            # Yield output lines as they arrive
            while not done_event.is_set():
                try:
                    stream_type, text = line_queue.get(timeout=0.1)
                    yield _emit("step_output", {
                        "node_id": node_id,
                        "stream": stream_type,
                        "text": text,
                    })
                except _queue.Empty:
                    pass

            # Drain remaining lines
            while not line_queue.empty():
                try:
                    stream_type, text = line_queue.get_nowait()
                    yield _emit("step_output", {
                        "node_id": node_id,
                        "stream": stream_type,
                        "text": text,
                    })
                except _queue.Empty:
                    break

            t.join(timeout=5)
            result = result_holder[0] if result_holder else {
                "stdout": "", "stderr": "Thread didn't complete",
                "return_code": 1, "execution_time": 0, "output": {},
            }
            final_result = result

            if result["return_code"] == 0:
                break  # success, stop retrying

        assert final_result is not None
        step_status = "success" if final_result["return_code"] == 0 else "failed"
        statuses[node_id] = step_status

        # Merge node's resolved args INTO the output dict so downstream nodes
        # can reference both input args and script outputs via placeholders.
        # Script output takes precedence over args in case of key collision.
        merged_output: dict[str, Any] = {}
        for k, v in resolved_args.items():
            merged_output[k] = str(v) if not isinstance(v, str) else v
        merged_output.update(final_result["output"])
        outputs[node_id] = merged_output

        if step_status == "failed":
            overall_status = "failed"

        # Update DB
        update_workflow_step(
            db_step_id,
            status=step_status,
            stdout=final_result["stdout"],
            stderr=final_result["stderr"],
            execution_time=final_result["execution_time"],
            retry_attempts=max_attempts - 1 if max_attempts > 1 else 0,
            output_json=final_result["output"],
        )

        yield _emit("step_complete", {
            "node_id": node_id,
            "status": step_status,
            "execution_time": final_result["execution_time"],
            "stdout": final_result["stdout"][-2000:],   # trim for SSE
            "stderr": final_result["stderr"][-2000:],
            "output": final_result["output"],
        })

        # -- Evaluate outgoing edges ----------------------------------------
        for edge in outgoing.get(node_id, []):
            should_run = (
                edge.condition == "always"
                or (edge.condition == "success" and step_status == "success")
                or (edge.condition == "failure" and step_status == "failed")
            )
            if should_run:
                if edge.target not in visited:
                    queue.append(edge.target)
            else:
                # Mark target (and its descendants) as skipped
                _skip_descendants(edge.target, nodes, outgoing, visited, statuses,
                                  step_ids, run_id, queue)

    # Mark any unvisited nodes as skipped
    for nid in nodes:
        if nid not in visited:
            if nid not in step_ids:
                sid = save_workflow_step(run_id, nid, nodes[nid].script, "skipped")
                step_ids[nid] = sid
            statuses[nid] = "skipped"
            yield _emit("step_skipped", {"node_id": nid})

    # -- Finalize run -------------------------------------------------------
    update_workflow_run(run_id, overall_status)
    yield _emit("workflow_end", {"run_id": run_id, "status": overall_status})


def _skip_descendants(
    node_id: str,
    nodes: dict[str, WorkflowNode],
    outgoing: dict[str, list[WorkflowEdge]],
    visited: set[str],
    statuses: dict[str, str],
    step_ids: dict[str, int],
    run_id: int,
    queue: list[str],
) -> None:
    """Recursively mark a node and its descendants as skipped."""
    if node_id in visited or node_id in statuses:
        return
    visited.add(node_id)
    statuses[node_id] = "skipped"
    node = nodes.get(node_id)
    if node and node_id not in step_ids:
        sid = save_workflow_step(run_id, node_id, node.script, "skipped")
        step_ids[node_id] = sid

    # Remove from queue if queued
    if node_id in queue:
        queue.remove(node_id)

    for edge in outgoing.get(node_id, []):
        _skip_descendants(edge.target, nodes, outgoing, visited, statuses,
                          step_ids, run_id, queue)
