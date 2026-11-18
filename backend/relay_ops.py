"""
relay_ops.py - run relayctl.py (bench relay / Pi recovery tool) from the dashboard.

relayctl.py lives on the DTA server (default ~/shankar/relay_recovery, override with the
RELAYCTL_DIR env var). Only a fixed list of its sub-commands can be run, arguments are
validated and passed as an argv list (never through a shell).

Jobs run detached (own session) and write to a log file, so a 17-20 minute
`restart device` keeps going if the browser tab is closed or the backend restarts.
The browser polls /relay/jobs/{id}?after=N for new lines.

Rules carried over from relayctl's own notes:
  * switching commands need an explicit confirmation (yes=True) unless they are dry runs
  * only one switching job per bench / Pi at a time
  * --force (override the "bench is in use" guard) is opt-in per request
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

RELAYCTL_DIR = Path(os.environ.get("RELAYCTL_DIR", "~/shankar/relay_recovery")).expanduser()
RELAYCTL_PY = RELAYCTL_DIR / "relayctl.py"
RELAYCTL_LOG = RELAYCTL_DIR / "relayctl.log"
JOB_LOG_DIR = Path(__file__).resolve().parent / "output" / "relay_jobs"

# Bench lists from the daily-commands notes (D215 = K2, D450 = B3).
BENCH_GROUPS: dict[str, dict[str, Any]] = {
    "D215": {
        "label": "D215",
        "benches": "6603083402 6603083306 6603083417 6603073901 6603085697 6603083308 6603029208 6603053381 6603055842".split(),
    },
    "D450": {
        "label": "D450",
        "benches": "103412400067 103212503890 103032500995 103212503735 103212503844 103212503865 103092501125 103332400245 103212503803".split(),
    },
}

_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_TARGETS = 30
MAX_LINES = 20000


# ---------------------------------------------------------------------------
# Command catalogue (single source of truth; the UI renders from /relay/config)
# ---------------------------------------------------------------------------
# argv:     fixed leading arguments after relayctl.py
# target:   "benches" (1+ benches), "bench", "pi", "pi_or_bench", "optional_pi", "none"
# switching: changes state, needs confirmation and the busy guard
COMMANDS: dict[str, dict[str, Any]] = {
    "check": {
        "group": "Before every run", "label": "Check benches", "argv": ["check"], "target": "benches",
        "switching": False, "timeout": 900,
        "help": "DEVICE / RELAY / PI verdict per bench. Also switches each healthy bench's relay ON (RELAY: ON). Look for BAD, no ping, unstable, WRONG ID.",
    },
    "boards": {
        "group": "Before every run", "label": "Check relay boards", "argv": ["boards"], "target": "optional_pi",
        "switching": False, "timeout": 600,
        "help": "Real relay boards per Pi; flags any bench with a wrong board id.",
    },
    "discover": {
        "group": "When something changed", "label": "Discover topology", "argv": ["discover"], "target": "none",
        "switching": False, "timeout": 300,
        "help": "Re-learns bench, Pi, board and channel from the UDP broadcasts (about 20 s).",
    },
    "status": {
        "group": "When something changed", "label": "Bench status", "argv": ["status"], "target": "benches",
        "switching": False, "timeout": 300,
        "help": "Detailed table: pings, ARP, ports 22/8081, board, channel.",
    },
    "pi-benches": {
        "group": "When something changed", "label": "Benches on a Pi", "argv": ["pi-benches"], "target": "pi",
        "switching": False, "timeout": 120,
        "help": "Which benches hang off a Pi.",
    },
    "pi-check": {
        "group": "Relay or Pi problems", "label": "Check Pi", "argv": ["pi-check"], "target": "pi",
        "switching": False, "timeout": 300,
        "help": "Logs in to the Pi: uptime, USB boards, network.",
    },
    "wake": {
        "group": "A bench is not answering", "label": "Wake bench", "argv": ["wake"], "target": "bench",
        "switching": True, "timeout": 600,
        "help": "Ignition ON, then waits for the bench to answer ping.",
    },
    "restart-device": {
        "group": "A bench is not answering", "label": "Restart device", "argv": ["restart", "device"], "target": "bench",
        "switching": True, "timeout": 55 * 60, "min_timeout": 55 * 60,
        "help": "Checks the bench answers ping, then ignition OFF, keeps it OFF for 30 minutes in total (ping stops long before the device is really off), then ON. Takes about 35 minutes. Works the same on a bench that is up, hung or silent.",
    },
    "restart-relay": {
        "group": "Relay or Pi problems", "label": "Restart relay service", "argv": ["restart", "relay"], "target": "pi_or_bench",
        "switching": True, "timeout": 300,
        "help": "Restarts the relay service on the Pi (back in about 3 s). Switches every channel on that Pi's boards ON.",
    },
    "restart-pi": {
        "group": "Relay or Pi problems", "label": "Reboot Pi", "argv": ["restart", "pi"], "target": "pi",
        "switching": True, "timeout": 900,
        "help": "Reboots the Pi (back in 1-2 min). Switches every channel on that Pi's boards ON. "
                "If it does not return in 240 s only its wall adapter can help.",
    },
    "recover": {
        "group": "Relay or Pi problems", "label": "Recover bench", "argv": ["recover"], "target": "bench",
        "switching": True, "timeout": 45 * 60,
        "help": "Walks the whole ladder: wake, then relay restart, then Pi reboot, checking after each step.",
    },
}

SHORT = {
    "check": "verdict per bench; turns the relays ON",
    "boards": "real relay boards per Pi, flags wrong board ids",
    "discover": "re-learn bench, Pi, board and channel (about 20 s)",
    "status": "detailed table for benches (all benches if none given)",
    "pi-benches": "benches wired to a Pi",
    "pi-check": "uptime, USB boards and network of a Pi",
    "wake": "ignition ON, wait for ping",
    "restart-device": "ignition OFF 30 min, then ON (about 35 min)",
    "restart-relay": "restart the relay service on a Pi (about 3 s)",
    "restart-pi": "reboot a Pi (1-2 min)",
    "recover": "wake, then relay restart, then Pi reboot",
}
# Commands where the wait limit can be changed (they wait for something to come back).
LONG_RUNNING = {"wake", "restart-device", "restart-pi", "recover"}
DEFAULT_LONG_TIMEOUT = 1800
MIN_TIMEOUT, MAX_TIMEOUT = 60, 7200

for _k, _spec in COMMANDS.items():
    _spec["name"] = " ".join(_spec["argv"])             # exactly what you type after relayctl.py
    _spec["option"] = f"{_spec['name']} - {SHORT[_k]}"  # dropdown text
    _spec["timeout_input"] = _k in LONG_RUNNING
COMMANDS["status"]["target"] = "optional_benches"


def inputs_for(spec: dict[str, Any]) -> dict[str, str | None]:
    """Which inputs a command uses: 'required', 'optional', 'one of' (either Pi or device id) or None."""
    t = spec["target"]
    return {
        "bench_ids": {"benches": "required", "bench": "required", "optional_benches": "optional", "pi_or_bench": "one of"}.get(t),
        "pi": {"pi": "required", "optional_pi": "optional", "pi_or_bench": "one of"}.get(t),
        "dry_run": "optional" if spec["switching"] else None,
        "timeout": "optional" if spec["timeout_input"] else None,
    }


def command_by_option(text: str) -> str | None:
    """Accepts the dropdown text, the relayctl name ('restart device') or the key ('restart-device')."""
    head = text.split(" - ")[0].strip()
    return next((k for k, v in COMMANDS.items() if text == v["option"] or head in (v["name"], k)), None)


RULES = [
    "Do a dry run first. Switching commands need confirmation.",
    "Do not touch a bench or Pi while a test run uses it. relayctl refuses to switch a bench that looks in use.",
    "Restart relay and Reboot Pi switch every channel on that Pi's boards ON.",
    "A command is refused if the bench's board id is not a real board.",
    "If a Pi does not come back in 240 s, only its wall adapter can help.",
]


# ---------------------------------------------------------------------------
# Job registry
# ---------------------------------------------------------------------------

# State lives in files (<id>.json meta + <id>.log output) because the backend runs several worker
# processes: the worker that starts a job is rarely the one that answers the next poll.
_lock = threading.Lock()   # guards meta writes inside one process


def available() -> bool:
    return RELAYCTL_PY.is_file()


def config() -> dict[str, Any]:
    return {
        "available": available(),
        "relayctl_path": str(RELAYCTL_PY),
        "groups": [{"key": k, "label": v["label"], "benches": v["benches"]} for k, v in BENCH_GROUPS.items()],
        "default_timeout": DEFAULT_LONG_TIMEOUT,
        "commands": [
            {"key": k, "name": v["name"], "option": v["option"], "group": v["group"], "switching": v["switching"],
             "help": v["help"], "inputs": inputs_for(v), "multiple": v["target"] in ("benches", "optional_benches")}
            for k, v in COMMANDS.items()
        ],
        "rules": RULES,
    }


class RelayError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _split_targets(raw: list[str]) -> list[str]:
    """Accept spaces, commas, brackets, quotes and newlines between ids; keep order, drop duplicates."""
    out: list[str] = []
    for item in raw:
        for tok in re.split(r"[\s,;\[\]\"']+", str(item)):
            if tok and tok not in out:
                out.append(tok)
    return out


def build_argv(command: str, targets: list[str], dry_run: bool, force: bool) -> tuple[list[str], list[str]]:
    """Validate the request and return (argv, normalised targets)."""
    spec = COMMANDS.get(command)
    if spec is None:
        raise RelayError(400, f"Unknown command '{command}'")
    toks = _split_targets(targets)
    for t in toks:
        if not _TOKEN.match(t):
            raise RelayError(400, f"Invalid name or id: {t!r}")
    if len(toks) > MAX_TARGETS:
        raise RelayError(400, f"At most {MAX_TARGETS} targets per run")

    kind = spec["target"]
    if kind == "none" and toks:
        raise RelayError(400, f"'{spec['name']}' takes no device id or Pi")
    if kind in ("bench", "pi", "pi_or_bench") and len(toks) != 1:
        raise RelayError(400, f"'{spec['name']}' needs exactly one {'Pi name' if kind == 'pi' else 'device id' if kind == 'bench' else 'Pi name or device id'}")
    if kind == "benches" and not toks:
        raise RelayError(400, f"'{spec['name']}' needs at least one device id")
    if kind == "optional_pi" and len(toks) > 1:
        raise RelayError(400, f"'{spec['name']}' takes at most one Pi")

    argv = ["python3", "-u", str(RELAYCTL_PY), *spec["argv"], *toks]
    if spec["switching"]:
        if dry_run:
            argv.append("--dry-run")
        else:
            argv.append("--yes")
            if force:
                argv.append("--force")
    return argv, toks


def check_conflict(command: str, targets: list[str]) -> None:
    """`check` turns relays ON. Refuse while a restart/recover is holding one of these benches OFF."""
    if command != "check":
        return
    for j in _all_meta():
        if j["state"] == "running" and j["switching"] and set(j["keys"]) & set(targets):
            clash = ", ".join(sorted(set(j["keys"]) & set(targets)))
            raise RelayError(409, f"{clash} is being switched by '{j['label']}' (job {j['id']}). Checking now would turn its relay ON in the middle of it. Wait for it to finish.")


def _busy_keys(command: str, targets: list[str]) -> set[str]:
    return set(targets) if COMMANDS[command]["switching"] else set()


def _meta_path(job_id: str) -> Path:
    return JOB_LOG_DIR / f"{job_id}.json"


def _log_path(job_id: str) -> Path:
    return JOB_LOG_DIR / f"{job_id}.log"


def _write_meta(job: dict[str, Any]) -> None:
    tmp = _meta_path(job["id"]).with_suffix(".tmp")
    with _lock:
        tmp.write_text(json.dumps(job), encoding="utf-8")
        os.replace(tmp, _meta_path(job["id"]))


def _read_meta(job_id: str) -> dict[str, Any] | None:
    if not re.fullmatch(r"[0-9a-f]{10}", job_id):
        return None
    try:
        job = json.loads(_meta_path(job_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    # A job still marked running whose relayctl process is gone: its watcher died (backend restart).
    if job["state"] == "running" and job.get("pid") and not _pid_alive(job["pid"]):
        job.update(state="lost", finished=job.get("finished") or time.time())
    return job


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A finished child that nobody reaped yet is a zombie: not alive for our purposes.
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1][0] != "Z"
    except (OSError, IndexError):
        return True


def _all_meta() -> list[dict[str, Any]]:
    if not JOB_LOG_DIR.is_dir():
        return []
    out = []
    for f in sorted(JOB_LOG_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:60]:
        m = _read_meta(f.stem)
        if m:
            out.append(m)
    return sorted(out, key=lambda m: m["started"], reverse=True)


def start_job(command: str, targets: list[str], dry_run: bool, confirmed: bool, force: bool, actor: str = "", timeout: int | None = None) -> dict[str, Any]:
    if not available():
        raise RelayError(503, f"relayctl.py not found at {RELAYCTL_PY}. Set RELAYCTL_DIR on the server running the backend.")
    spec = COMMANDS.get(command)
    if spec is None:
        raise RelayError(400, f"Unknown command '{command}'")
    if spec["switching"] and not dry_run and not confirmed:
        raise RelayError(400, "This command changes state: confirm it, or run it as a dry run.")

    argv, toks = build_argv(command, targets, dry_run, force)
    keys = _busy_keys(command, toks) if not dry_run else set()
    check_conflict(command, toks)
    limit = spec["timeout"] if timeout is None else max(MIN_TIMEOUT, min(int(timeout), MAX_TIMEOUT))
    limit = max(limit, spec.get("min_timeout", 0))     # a too-short limit would kill a restart while the bench is still OFF

    job_id = uuid.uuid4().hex[:10]
    JOB_LOG_DIR.mkdir(parents=True, exist_ok=True)
    job = {
        "id": job_id, "command": command, "label": spec["name"], "targets": toks,
        "dry_run": dry_run, "force": force, "switching": spec["switching"],
        "display": " ".join(["relayctl.py", *spec["argv"], *toks] + argv[3 + len(spec["argv"]) + len(toks):]),
        "actor": actor[:80], "started": time.time(), "finished": None,
        "state": "running", "exit_code": None, "keys": sorted(keys), "pid": None,
    }
    # Check-and-create under a file lock, so two workers cannot both start a switch on the same bench.
    with open(JOB_LOG_DIR / ".lock", "w") as lockf:
        fcntl.flock(lockf, fcntl.LOCK_EX)
        for j in _all_meta():
            if j["state"] == "running" and set(j["keys"]) & keys:
                clash = ", ".join(sorted(set(j["keys"]) & keys))
                raise RelayError(409, f"{clash} is already being switched by job {j['id']} ({j['label']}). Wait for it to finish.")
        _log_path(job_id).write_text("", encoding="utf-8")
        _write_meta(job)
        try:
            proc = subprocess.Popen(
                argv, cwd=str(RELAYCTL_DIR), stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, start_new_session=True,
                env={**os.environ, "PYTHONUNBUFFERED": "1", "TERM": "dumb"},
            )
        except OSError as exc:
            _log_path(job_id).write_text(f"Failed to start: {exc}\n", encoding="utf-8")
            job.update(state="error", finished=time.time(), exit_code=-1)
            _write_meta(job)
            return _view(job, 0)
        job["pid"] = proc.pid
        _write_meta(job)

    threading.Thread(target=_pump, args=(job, proc, limit), daemon=True).start()
    return _view(job, 0)


def _pump(job: dict[str, Any], proc: subprocess.Popen, timeout: int) -> None:
    killer = threading.Timer(timeout, lambda: proc.poll() is None and _kill(proc))
    killer.daemon = True
    killer.start()
    try:
        with open(_log_path(job["id"]), "a", encoding="utf-8") as fh:
            assert proc.stdout is not None
            for raw in proc.stdout:
                fh.write(raw if raw.endswith("\n") else raw + "\n")
                fh.flush()
        code = proc.wait()
    except Exception as exc:  # noqa: BLE001 - surface any reader failure in the job
        code = -1
        with open(_log_path(job["id"]), "a", encoding="utf-8") as fh:
            fh.write(f"[reader error: {exc}]\n")
    finally:
        killer.cancel()
    if code != 0 and time.time() - job["started"] >= timeout:
        with open(_log_path(job["id"]), "a", encoding="utf-8") as fh:
            fh.write(f"[stopped: exceeded the {timeout // 60} min limit]\n")
    job.update(exit_code=code, finished=time.time(), state="done" if code == 0 else "failed")
    _write_meta(job)


def _kill(proc: subprocess.Popen) -> None:
    try:
        proc.terminate()
    except OSError:
        pass


def _view(job: dict[str, Any], after: int) -> dict[str, Any]:
    try:
        lines = _log_path(job["id"]).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        lines = []
    if len(lines) > MAX_LINES:
        lines = lines[-MAX_LINES:]
    out = {k: job[k] for k in ("id", "command", "label", "targets", "dry_run", "force", "switching",
                               "display", "actor", "started", "finished", "state", "exit_code")}
    out["lines"] = lines[max(0, after):]
    out["next"] = len(lines)
    return out


def get_job(job_id: str, after: int = 0) -> dict[str, Any]:
    job = _read_meta(job_id)
    if job is None:
        raise RelayError(404, "Unknown job. It may have been cleaned up; see the audit log.")
    return _view(job, max(0, after))


def list_jobs() -> list[dict[str, Any]]:
    out = []
    for m in _all_meta()[:50]:
        v = _view(m, 10**9)
        v.pop("lines")
        out.append(v)
    return out


def audit_tail(n: int = 40) -> list[str]:
    """Last n lines of relayctl.log (every switching action: time, user, result)."""
    if not RELAYCTL_LOG.is_file():
        return []
    try:
        with open(RELAYCTL_LOG, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 64 * 1024))
            data = fh.read().decode("utf-8", "replace")
    except OSError:
        return []
    return data.splitlines()[-max(1, min(n, 200)):]
