"""
tc_jobs.py - queue of Claude jobs behind the Release Tickets "Team status" columns.

Three stages per Jira ticket, each run by the bug-regression Claude skill:

  generate   -> writes the regression testcases        (Generated TCs)
  validate   -> runs them on a device                  (Validated in device)
  include    -> pushes them to a new nd_test_bot branch (Included in runs)

and a fourth that is not a column of its own:

  regenerate -> after the fix PRs merge, re-checks the testcases against the merged
                code and updates them in place (Generated TCs stays Yes). When
                something really changed, Validated in device is reset, because the
                earlier device run was of the old testcases.

This backend only QUEUES jobs. It has no claude CLI and no bug-regression project.
A worker on a workstation (tools/tc_worker.py) claims a job, runs
`claude -p /bug-regression:bug-regression ...` there, streams the log back and reports
the result. Everything shared is in SQLite because the server runs several uvicorn
workers (never keep job state in process memory).

Stage order is enforced here when a job is queued, and again by the worker against
the files really on disk.

Device passwords are never written to the database or the job log. They wait in a
0600 file under output/tc_job_secrets/ until the worker claims the job, then the
file is deleted.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import database as db

STAGES = ("generate", "validate", "include", "regenerate", "remove")
ACTIVE = ("queued", "running")
SECRET_DIR = Path(__file__).resolve().parent / "output" / "tc_job_secrets"
SECRET_MAX_AGE = 24 * 3600      # an unclaimed password is thrown away after a day
WORKER_ONLINE_SEC = 30          # a worker polls every few seconds
STALE_RUNNING_SEC = 300         # a running job whose worker went silent is failed
MAX_LOG_CHARS = 400_000

# The skill handles the DT and OCTO bug projects only.
DT_RE = re.compile(r"^(DT|OCTO)-\d{1,7}$")
DEVICE_RE = re.compile(r"^[A-Za-z0-9]{6,24}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$")

# What each outcome reported by the worker writes into the team-status cell.
# covered: an existing testcase already does it · not_testable: nothing to test or no way to trigger it
# (a permanent verdict, unlike a failed job, which is worth running again later)
GENERATE_OUTCOMES = {"generated": "Yes", "covered": "N/A", "not_testable": "N/A"}
VALIDATE_OUTCOMES = {"yes": "Yes", "partial": "Partial", "no": "No"}
VALIDATE_NO_CHANGE = ("inconclusive",)    # a run that proves nothing leaves the cell as it was
VALIDATE_MODES = ("fixed", "unfixed", "both")
# updated: testcase files changed · unchanged: still correct · not_merged: fix PRs still open
REGENERATE_OUTCOMES = ("updated", "unchanged", "not_merged")
REMOVE_OUTCOMES = ("removed", "absent")      # absent: the testcases were not on that branch (any more)
# A device result of these values belonged to the old testcases and is cleared on an update.
RESET_ON_UPDATE = ("Yes", "Partial", "No")


class JobError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Input checks
# ---------------------------------------------------------------------------

def valid_branch(name: str) -> bool:
    return bool(
        BRANCH_RE.fullmatch(name)
        and ".." not in name and "//" not in name
        and not name.endswith(("/", ".", ".lock"))
    )


def runs_list(text: str) -> list[str]:
    return [p.strip() for p in (text or "").split(",") if p.strip()]


PROTECTED_BRANCHES = ("main", "master")   # the testcases are never pushed straight into these


def is_protected(branch: str) -> bool:
    return branch.removeprefix("origin/").lower() in PROTECTED_BRANCHES


def _password(value: str, label: str) -> str:
    if not value:
        raise JobError(f"{label} is required.")
    if len(value) > 128 or any(c in value for c in "\n\r\0"):
        raise JobError(f"{label} is not a usable password.")
    return value


def clean_params(stage: str, raw: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    """Return (params saved with the job, secrets kept out of the database)."""
    get = lambda k: str(raw.get(k) or "").strip()  # noqa: E731
    if stage in ("generate", "regenerate"):
        return {}, {}
    if stage == "validate":
        device, unfixed = get("device_id"), get("unfixed_device_id")
        mode = get("mode") or ("both" if device and unfixed else "fixed")
        if mode not in VALIDATE_MODES:
            raise JobError("Choose the device with the fix, the device without the fix, or both.")
        params: dict[str, str] = {"mode": mode}
        if raw.get("skip_device_checks"):
            params["skip_device_checks"] = "1"
        secrets: dict[str, str] = {}
        if mode in ("fixed", "both"):
            if not DEVICE_RE.fullmatch(device):
                raise JobError("Device ID must be 6 to 24 letters or digits.")
            params["device_id"] = device
            secrets["device_password"] = _password(str(raw.get("device_password") or ""), "Device password")
        if mode in ("unfixed", "both"):
            if not DEVICE_RE.fullmatch(unfixed):
                raise JobError("Unfixed device ID must be 6 to 24 letters or digits.")
            if mode == "both" and unfixed == device:
                raise JobError("The unfixed device must be a different device.")
            params["unfixed_device_id"] = unfixed
            secrets["unfixed_device_password"] = _password(
                str(raw.get("unfixed_device_password") or ""), "Unfixed device password")
        return params, secrets
    if stage == "include":
        branch, target = get("branch"), get("target") or "new"
        if target not in ("new", "existing"):
            raise JobError("Choose to push into that branch or to create a new branch from it.")
        if not valid_branch(branch):
            raise JobError("That is not a valid branch name.")
        if target == "existing":
            if is_protected(branch):
                raise JobError(f"{branch} is protected: the testcases are not pushed straight into it. "
                               f"Create a new branch from it instead.")
            if not raw.get("confirm_push"):
                raise JobError("Confirm that you want the testcases pushed directly into that branch.")
        out = {"branch": branch, "target": target}
        custom = get("new_branch")
        if target == "new" and custom:               # the user's own name for the new branch
            if not valid_branch(custom):
                raise JobError("That is not a valid name for the new branch.")
            if is_protected(custom):
                raise JobError(f"{custom} is a protected name: choose another name for the new branch.")
            if custom.removeprefix("origin/") == branch.removeprefix("origin/"):
                raise JobError("The new branch needs a different name than the branch it starts from.")
            out["new_branch"] = custom
        return out, {}
    if stage == "remove":
        branch = get("branch")
        if not valid_branch(branch):
            raise JobError("That is not a valid branch name.")
        if is_protected(branch):
            raise JobError(f"{branch} is protected: testcases are not removed from it from here.")
        if not raw.get("confirm_remove"):
            raise JobError("Confirm that you want the testcases removed from that branch.")
        return {"branch": branch}, {}
    raise JobError(f"Unknown stage: {stage}")


def check_previous_stage(stage: str, status: dict[str, Any] | None, params: dict[str, Any] | None = None) -> None:
    """A stage may start only when the stage before it is complete."""
    if stage == "remove":
        if (params or {}).get("branch") not in runs_list((status or {}).get("included_in_runs", "")):
            raise JobError("That branch is not listed in Included in runs for this ticket, so there is nothing to remove.", 409)
        return
    generated = (status or {}).get("generated_tcs", "")
    validated = (status or {}).get("validated", "")
    if stage in ("validate", "include", "regenerate") and generated != "Yes":
        raise JobError("Generate the testcases first: Generated TCs must be Yes.", 409)
    if stage == "include" and validated not in ("Yes", "Partial"):
        raise JobError("Validate on a device first: Validated in device must be Yes or Partial.", 409)


# ---------------------------------------------------------------------------
# Secrets (device passwords)
# ---------------------------------------------------------------------------

def _secret_path(job_id: str) -> Path:
    return SECRET_DIR / f"{job_id}.json"


def _store_secrets(job_id: str, secrets: dict[str, str]) -> None:
    if not secrets:
        return
    SECRET_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(SECRET_DIR, 0o700)
    fd = os.open(_secret_path(job_id), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(secrets, fh)


def _take_secrets(job_id: str) -> dict[str, str]:
    """Read a job's secrets and delete them: they are handed out exactly once."""
    path = _secret_path(job_id)
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    finally:
        _drop_secrets(job_id)
    return data if isinstance(data, dict) else {}


def _drop_secrets(job_id: str) -> None:
    try:
        _secret_path(job_id).unlink()
    except OSError:
        pass


def _sweep_secrets() -> None:
    try:
        for p in SECRET_DIR.glob("*.json"):
            if time.time() - p.stat().st_mtime > SECRET_MAX_AGE:
                p.unlink()
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Worker token
# ---------------------------------------------------------------------------

def token() -> str:
    return os.environ.get("TC_WORKER_TOKEN", "").strip()


def enabled() -> bool:
    return bool(token())


def check_token(given: str | None) -> None:
    if not enabled():
        raise JobError("Claude jobs are switched off: TC_WORKER_TOKEN is not set on the backend.", 503)
    if not given or not hmac.compare_digest(given.encode(), token().encode()):
        raise JobError("Wrong worker token.", 401)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

def _view(row: dict[str, Any], with_log: bool = False, after: int = 0) -> dict[str, Any]:
    job = {k: row[k] for k in (
        "id", "dt", "stage", "status", "message", "actor", "worker",
        "created_at", "started_at", "finished_at")}
    job["params"] = json.loads(row["params_json"] or "{}")
    job["result"] = json.loads(row["result_json"] or "{}")
    job["cancel_requested"] = bool(row["cancel_requested"])
    if with_log:
        log = row["log"] or ""
        after = max(0, min(after, len(log)))
        job["log"] = log[after:]
        job["log_end"] = len(log)
    return job


def _fail_stale(conn) -> None:
    """A running job whose worker stopped reporting is failed, and its cell put back."""
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=STALE_RUNNING_SEC)).isoformat()
    rows = conn.execute(
        "SELECT * FROM tc_jobs WHERE status = 'running' AND heartbeat_at < ?", (cutoff,)
    ).fetchall()
    for r in rows:
        _close(conn, dict(r), "failed", "", "Lost contact with the worker while the job was running.", {})


def worker_state(conn) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM tc_workers ORDER BY last_seen DESC LIMIT 1").fetchone()
    if not row:
        return {"online": False, "name": "", "last_seen": ""}
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(row["last_seen"])).total_seconds()
    return {"online": age <= WORKER_ONLINE_SEC, "name": row["name"], "last_seen": row["last_seen"]}


TC_FILE_RE = re.compile(r"^TC_[A-Za-z0-9_\-]{1,160}\.py$")
MAX_TC_FILE = 200_000


def sync_files(dt: str, shas: dict[str, Any], files: list[Any]) -> list[str]:
    """The worker's copy of a ticket's testcase files, so the page can show them.
    `shas` lists every file the ticket has now (anything else is dropped); `files` carries the content
    of the ones the server asked for. Returns the names whose content the server still needs."""
    dt = str(dt).strip().upper()
    if not DT_RE.fullmatch(dt) or not isinstance(shas, dict):
        raise JobError("Bad ticket or file list.")
    names = {n: str(h)[:64] for n, h in shas.items() if TC_FILE_RE.fullmatch(str(n))}
    conn = db._connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        for f in (files if isinstance(files, list) else [])[:40]:
            if not isinstance(f, dict) or f.get("name") not in names:
                continue
            text = str(f.get("content") or "")[:MAX_TC_FILE]
            conn.execute(
                """INSERT INTO tc_files (dt, name, sha, content, updated_at) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(dt, name) DO UPDATE SET sha = excluded.sha, content = excluded.content,
                       updated_at = excluded.updated_at""",
                (dt, f["name"], names[f["name"]], text, _now()))
        have = {r["name"]: r["sha"] for r in conn.execute("SELECT name, sha FROM tc_files WHERE dt = ?", (dt,))}
        for gone in set(have) - set(names):
            conn.execute("DELETE FROM tc_files WHERE dt = ? AND name = ?", (dt, gone))
        conn.commit()
        return sorted(n for n, h in names.items() if have.get(n) != h)
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_file(dt: str, name: str) -> dict[str, Any]:
    if not DT_RE.fullmatch(dt.strip().upper()) or not TC_FILE_RE.fullmatch(name):
        raise JobError("Bad ticket or file name.")
    conn = db._connect()
    try:
        row = conn.execute("SELECT name, content, updated_at FROM tc_files WHERE dt = ? AND name = ?",
                           (dt.strip().upper(), name)).fetchone()
    finally:
        conn.close()
    if not row:
        raise JobError("The worker has not sent this testcase yet. It does so every few minutes.", 404)
    return dict(row)


# ---------------------------------------------------------------------------
# Ticket details: what the testcases are based on, in plain words (loaded when a ticket is opened)
# ---------------------------------------------------------------------------

def _txt(value: Any, n: int = 1500) -> str:
    return " ".join(str(value or "").split())[:n]


def clean_details(data: Any) -> dict[str, Any]:
    """Short plain strings in known places only: this comes from files on a workstation."""
    d = data if isinstance(data, dict) else {}
    plain = d.get("plain") if isinstance(d.get("plain"), dict) else {}
    conf = d.get("confidence")
    prs = []
    for p in (d.get("prs") if isinstance(d.get("prs"), list) else [])[:40]:
        if isinstance(p, dict) and p.get("id"):
            url = _txt(p.get("url"), 300)
            prs.append({
                "key": _txt(p.get("key"), 120), "repo": _txt(p.get("repo"), 80), "id": _txt(p.get("id"), 20),
                "title": _txt(p.get("title"), 300), "status": _txt(p.get("status"), 12).upper(),
                "url": url if url.startswith("https://") else "", "target": _txt(p.get("target"), 120),
                "source": _txt(p.get("source"), 120), "commit": _txt(p.get("commit"), 12),
                "used": p.get("used") if isinstance(p.get("used"), bool) else None,
                "why": _txt(p.get("why"), 400), "summary": _txt(p.get("summary"), 800),
                "files": [_txt(f, 160) for f in (p.get("files") if isinstance(p.get("files"), list) else [])[:8]],
                "by": p.get("by") if p.get("by") in ("claude", "bundle") else "bundle"})
    tickets = []
    for t in (d.get("tc_tickets") if isinstance(d.get("tc_tickets"), list) else [])[:40]:
        if isinstance(t, dict) and re.fullmatch(r"[A-Z][A-Z0-9]*-\d+", str(t.get("key") or "")):
            url = _txt(t.get("url"), 300)
            tickets.append({"key": t["key"], "url": url if url.startswith("https://") else "",
                            "testcase": _txt(t.get("testcase"), 200)})
    return {
        "analysis_at": _txt(d.get("analysis_at"), 30), "target_branch": _txt(d.get("target_branch"), 120),
        "confidence": float(conf) if isinstance(conf, (int, float)) and not isinstance(conf, bool) else None,
        "plain": {"problem": _txt(plain.get("problem")), "fix": _txt(plain.get("fix")),
                  "changes": [_txt(x, 500) for x in (plain.get("changes") if isinstance(plain.get("changes"), list) else [])[:14]],
                  "how_tests_tell": _txt(plain.get("how_tests_tell")),
                  "not_covered": [_txt(x, 400) for x in (plain.get("not_covered") if isinstance(plain.get("not_covered"), list) else [])[:12]]},
        "tests": [{"testcase": _txt(t.get("testcase"), 200), "what": _txt(t.get("what"), 700)}
                  for t in (d.get("tests") if isinstance(d.get("tests"), list) else [])[:40] if isinstance(t, dict) and t.get("testcase")],
        "prs": prs, "tc_tickets": tickets,
        "technical": [{"label": _txt(t.get("label"), 60), "text": _txt(t.get("text"), 2500)}
                      for t in (d.get("technical") if isinstance(d.get("technical"), list) else [])[:14] if isinstance(t, dict) and t.get("text")],
    }


def set_details(items: dict[str, Any]) -> int:
    if not isinstance(items, dict):
        raise JobError("items must be an object.")
    conn = db._connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        n = 0
        for dt, data in list(items.items())[:500]:
            if DT_RE.fullmatch(str(dt)):
                conn.execute(
                    """INSERT INTO tc_details (dt, data_json, updated_at) VALUES (?, ?, ?)
                       ON CONFLICT(dt) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at""",
                    (dt, json.dumps(clean_details(data)), _now()))
                n += 1
        conn.commit()
        return n
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_details(dt: str) -> dict[str, Any]:
    dt = dt.strip().upper()
    if not DT_RE.fullmatch(dt):
        raise JobError("Not a ticket key.")
    conn = db._connect()
    try:
        row = conn.execute("SELECT data_json, updated_at FROM tc_details WHERE dt = ?", (dt,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise JobError("The worker has not sent the details of this ticket yet. It does so every few minutes.", 404)
    return {**clean_details(json.loads(row["data_json"])), "updated_at": row["updated_at"]}   # old rows get any new field


REQ_LISTS = ("runs_on", "na_on", "needs", "notes", "testcases")


def clean_requirements(data: Any) -> dict[str, Any]:
    """Only short plain strings in known lists: this comes from files on a workstation."""
    data = data if isinstance(data, dict) else {}
    out: dict[str, Any] = {}
    for key in REQ_LISTS:
        raw = data.get(key)
        raw = raw if isinstance(raw, list) else []
        out[key] = [" ".join(str(x).split())[:400] for x in raw[:20] if str(x).strip()]
    for key in ("fixed_build", "unfixed_build"):
        out[key] = " ".join(str(data.get(key) or "").split())[:400]
    nc = data.get("pr_new_commits") if isinstance(data.get("pr_new_commits"), list) else []
    out["pr_new_commits"] = [
        {"pr": str(c.get("pr") or "")[:120], "before": str(c.get("before") or "")[:12], "now": str(c.get("now") or "")[:12]}
        for c in nc[:20] if isinstance(c, dict) and c.get("pr")]
    cov = data.get("pr_coverage") if isinstance(data.get("pr_coverage"), dict) else {}
    out["pr_coverage"] = {
        str(k)[:120]: {"used": v.get("used") if isinstance(v.get("used"), bool) else None,
                       "why": " ".join(str(v.get("why") or "").split())[:200],
                       "by": v.get("by") if v.get("by") in ("claude", "bundle") else "bundle"}
        for k, v in list(cov.items())[:40] if isinstance(v, dict)}
    snap = data.get("pr_snapshot") if isinstance(data.get("pr_snapshot"), dict) else {}
    out["pr_snapshot"] = {str(k)[:120]: str(v).upper()[:12] for k, v in list(snap.items())[:40]}
    out["pr_snapshot_at"] = str(data.get("pr_snapshot_at") or "")[:30]
    checks = data.get("device_checks") if isinstance(data.get("device_checks"), list) else []
    ok = ("match", "nomatch", "skip")
    out["device_checks"] = [
        {"what": " ".join(str(c.get("what") or "").split())[:200],
         "fixed": c.get("fixed") if c.get("fixed") in ok else "skip", "unfixed": c.get("unfixed") if c.get("unfixed") in ok else "skip"}
        for c in checks[:12] if isinstance(c, dict) and str(c.get("what") or "").strip()]
    val = data.get("validation") if isinstance(data.get("validation"), dict) else {}
    out["validation"] = {
        n: {"status": v.get("status") if v.get("status") in ("yes", "partial", "failed", "na", "not_run") else "not_run",
            "fixed_device": str(v.get("fixed_device") or "")[:24], "unfixed_device": str(v.get("unfixed_device") or "")[:24]}
        for n, v in list(val.items())[:40] if TC_FILE_RE.fullmatch(str(n)) and isinstance(v, dict)}
    return out


def set_requirements(items: dict[str, Any]) -> int:
    """Store what each ticket's testcases need to be validated (from the worker's files)."""
    if not isinstance(items, dict):
        raise JobError("items must be an object.")
    conn = db._connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        n = 0
        for dt, data in list(items.items())[:500]:
            if not DT_RE.fullmatch(str(dt)):
                continue
            conn.execute(
                """INSERT INTO tc_requirements (dt, data_json, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT(dt) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at""",
                (dt, json.dumps(clean_requirements(data)), _now()))
            n += 1
        conn.commit()
        return n
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def overview() -> dict[str, Any]:
    """Latest job of every ticket and stage, plus whether a worker is listening."""
    conn = db._connect()
    try:
        # Polled by every open page, so only take the write lock when there is something to fail.
        if conn.execute("SELECT 1 FROM tc_jobs WHERE status = 'running' LIMIT 1").fetchone():
            conn.execute("BEGIN IMMEDIATE")
            _fail_stale(conn)
            conn.commit()
        rows = conn.execute(
            """
            SELECT j.* FROM tc_jobs j
            JOIN (SELECT dt, stage, MAX(created_at) AS latest FROM tc_jobs GROUP BY dt, stage) m
              ON m.dt = j.dt AND m.stage = j.stage AND m.latest = j.created_at
            """
        ).fetchall()
        return {
            "enabled": enabled(),
            "worker": worker_state(conn),
            "jobs": [_view(dict(r)) for r in rows],
            "accepted_gaps": {r["job_id"]: r["accepted_by"]
                              for r in conn.execute("SELECT job_id, accepted_by FROM tc_gap_accepted")},
            "requirements": {r["dt"]: json.loads(r["data_json"])
                             for r in conn.execute("SELECT dt, data_json FROM tc_requirements")},
        }
    finally:
        conn.close()


def get_job(job_id: str, after: int = 0) -> dict[str, Any]:
    conn = db._connect()
    try:
        row = conn.execute("SELECT * FROM tc_jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise JobError("Unknown job.", 404)
        return _view(dict(row), with_log=True, after=after)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Queueing and cancelling (from the page)
# ---------------------------------------------------------------------------

def _set_cell(conn, dt: str, field: str, value: str, actor: str) -> None:
    conn.execute(
        f"""
        INSERT INTO ticket_status (dt, {field}, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(dt) DO UPDATE SET {field} = excluded.{field},
            updated_by = excluded.updated_by, updated_at = excluded.updated_at
        """,
        (dt, value, actor, _now()),
    )


def open_gaps(conn, dt: str) -> tuple[str, list[str], str]:
    """(job id, open items, accepted_by) of the latest finished validate run of a ticket.
    The acceptance belongs to that run: a newer validate run has to be accepted again."""
    row = conn.execute(
        "SELECT id, result_json FROM tc_jobs WHERE dt = ? AND stage = 'validate' AND status = 'done' "
        "ORDER BY created_at DESC LIMIT 1", (dt,)).fetchone()
    if not row:
        return "", [], ""
    try:
        items = json.loads(row["result_json"] or "{}").get("remaining") or []
    except ValueError:
        items = []
    items = [str(i) for i in items] if isinstance(items, list) else []
    got = conn.execute("SELECT accepted_by FROM tc_gap_accepted WHERE job_id = ?", (row["id"],)).fetchone()
    return row["id"], items, (got["accepted_by"] if got else "")


def create_job(dt: str, stage: str, raw: dict[str, Any], actor: str) -> dict[str, Any]:
    if not enabled():
        raise JobError("Claude jobs are switched off: TC_WORKER_TOKEN is not set on the backend.", 503)
    dt = dt.strip().upper()
    if not DT_RE.fullmatch(dt):
        raise JobError("Claude jobs work on DT and OCTO tickets only.")
    if stage not in STAGES:
        raise JobError(f"Unknown stage: {stage}")
    params, secrets = clean_params(stage, raw)
    actor = (actor or "").strip()[:80]
    job_id = uuid.uuid4().hex
    _sweep_secrets()

    conn = db._connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        _fail_stale(conn)
        busy = conn.execute(
            "SELECT stage FROM tc_jobs WHERE dt = ? AND status IN ('queued', 'running')", (dt,)
        ).fetchone()
        if busy:
            raise JobError(f"{dt} already has a {busy['stage']} job in progress.", 409)
        status = conn.execute("SELECT * FROM ticket_status WHERE dt = ?", (dt,)).fetchone()
        check_previous_stage(stage, dict(status) if status else None, params)
        if (stage == "include" and params.get("target") == "existing") or stage == "remove":
            # Two pushes into one branch at the same time would race, and main_db.xlsx cannot be merged by hand.
            for other in conn.execute(
                "SELECT dt, stage, params_json FROM tc_jobs WHERE stage IN ('include', 'remove') AND status IN ('queued', 'running')"
            ).fetchall():
                o = json.loads(other["params_json"] or "{}")
                if o.get("branch") == params["branch"] and (other["stage"] == "remove" or o.get("target") == "existing"):
                    raise JobError(f"{other['dt']} is being {'removed from' if other['stage'] == 'remove' else 'included into'} "
                                   f"{params['branch']} right now. Wait for it to finish, so the two pushes do not collide.", 409)

        if stage == "include":
            gap_job, items, by = open_gaps(conn, dt)
            if items and not by:
                if not raw.get("accept_gaps"):
                    raise JobError(
                        f"The last validation left {len(items)} item(s) open. Tick \"I accept these open items\" "
                        f"to include the testcases anyway.", 409)
                if not actor:
                    raise JobError("Say who you are before accepting open items.", 400)
                conn.execute(
                    "INSERT OR REPLACE INTO tc_gap_accepted (job_id, dt, accepted_by, accepted_at) VALUES (?, ?, ?, ?)",
                    (gap_job, dt, actor, _now()))

        prev = ""
        if stage == "generate":
            prev = (status["generated_tcs"] if status else "") or ""
            _set_cell(conn, dt, "generated_tcs", "In progress", f"{actor or 'someone'} (Claude)")
        now = _now()
        conn.execute(
            """
            INSERT INTO tc_jobs (id, dt, stage, params_json, status, prev_value, actor, created_at)
            VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
            """,
            (job_id, dt, stage, json.dumps(params), prev, actor, now),
        )
        # Written inside the transaction so a claimed job always finds its password.
        _store_secrets(job_id, secrets)
        conn.commit()
    except BaseException:
        conn.rollback()
        _drop_secrets(job_id)
        raise
    finally:
        conn.close()
    return get_job(job_id)


def cancel_job(job_id: str) -> dict[str, Any]:
    """A queued job is dropped at once; a running one is stopped by its worker."""
    conn = db._connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM tc_jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise JobError("Unknown job.", 404)
        if row["status"] == "queued":
            _close(conn, dict(row), "cancelled", "", "Cancelled before it started.", {})
        elif row["status"] == "running":
            conn.execute("UPDATE tc_jobs SET cancel_requested = 1 WHERE id = ?", (job_id,))
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()
    return get_job(job_id)


# ---------------------------------------------------------------------------
# Worker side
# ---------------------------------------------------------------------------

def claim(worker: str, project_root: str = "") -> dict[str, Any] | None:
    """Record that a worker is alive and hand it the oldest queued job, if any."""
    worker = (worker or "worker").strip()[:80]
    conn = db._connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        now = _now()
        conn.execute(
            """
            INSERT INTO tc_workers (name, last_seen, project_root) VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen,
                project_root = excluded.project_root
            """,
            (worker, now, project_root[:300]),
        )
        row = conn.execute(
            "SELECT * FROM tc_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE tc_jobs SET status = 'running', worker = ?, started_at = ?, heartbeat_at = ? WHERE id = ?",
                (worker, now, now, row["id"]),
            )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()
    if not row:
        return None
    job = get_job(row["id"])
    job["secrets"] = _take_secrets(row["id"])
    return job


def progress(job_id: str, worker: str, log: str) -> dict[str, Any]:
    """Append log text and keep the job alive. Tells the worker whether to stop."""
    conn = db._connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT status, cancel_requested, worker FROM tc_jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise JobError("Unknown job.", 404)
        if row["status"] != "running" or row["worker"] != worker:
            conn.rollback()
            return {"cancel": True}   # no longer this worker's job: stop working on it
        conn.execute(
            "UPDATE tc_jobs SET log = substr(log || ?, -?), heartbeat_at = ? WHERE id = ?",
            (log or "", MAX_LOG_CHARS, _now(), job_id),
        )
        conn.commit()
        return {"cancel": bool(row["cancel_requested"])}
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def _close(conn, job: dict[str, Any], status: str, outcome: str, message: str, result: dict[str, Any]) -> None:
    """End a job and write what it achieved into the ticket's team-status cell."""
    dt, stage = job["dt"], job["stage"]
    actor = f"{job.get('actor') or 'someone'} (Claude)"
    if stage == "regenerate" and status == "done" and outcome == "updated":
        cur = conn.execute("SELECT validated, included_in_runs FROM ticket_status WHERE dt = ?", (dt,)).fetchone()
        old_validated = (cur["validated"] if cur else "") or ""
        old_runs = ((cur["included_in_runs"] if cur else "") or "").strip()
        if old_validated in RESET_ON_UPDATE:
            _set_cell(conn, dt, "validated", "", actor)
            message = f"{message} Validated in device was {old_validated} for the old testcases and is cleared: validate again."
        # Free text that people also type into, so it is left alone; the old branches are named instead.
        if old_runs:
            message = f"{message} Already listed in Included in runs: {old_runs}. Anything pushed there holds the old version."
        message = message.strip()
    if stage == "generate":
        value = GENERATE_OUTCOMES.get(outcome) if status == "done" else None
        # A job that did not finish puts the cell back, but only if nobody changed it since.
        if value is None:
            cur = conn.execute("SELECT generated_tcs FROM ticket_status WHERE dt = ?", (dt,)).fetchone()
            if cur and cur["generated_tcs"] == "In progress":
                _set_cell(conn, dt, "generated_tcs", job.get("prev_value") or "", actor)
        else:
            _set_cell(conn, dt, "generated_tcs", value, actor)
    elif stage == "validate" and status == "done" and outcome in VALIDATE_NO_CHANGE:
        pass
    elif stage == "validate" and status == "done" and outcome in VALIDATE_OUTCOMES:
        _set_cell(conn, dt, "validated", VALIDATE_OUTCOMES[outcome], actor)
    elif stage == "include" and status == "done":
        branch = str(result.get("branch") or "")
        cur = conn.execute("SELECT included_in_runs FROM ticket_status WHERE dt = ?", (dt,)).fetchone()
        have = (cur["included_in_runs"] if cur else "") or ""
        if branch not in [p.strip() for p in have.split(",")]:
            _set_cell(conn, dt, "included_in_runs", f"{have}, {branch}".strip(", ")[:500], actor)
    elif stage == "remove" and status == "done" and outcome in REMOVE_OUTCOMES:
        branch = str((json.loads(job.get("params_json") or "{}")).get("branch") or result.get("branch") or "")
        cur = conn.execute("SELECT included_in_runs FROM ticket_status WHERE dt = ?", (dt,)).fetchone()
        left = [b for b in runs_list(cur["included_in_runs"] if cur else "") if b != branch]
        _set_cell(conn, dt, "included_in_runs", ", ".join(left)[:500], actor)    # Validated in device stays as it is
    conn.execute(
        "UPDATE tc_jobs SET status = ?, message = ?, result_json = ?, finished_at = ? WHERE id = ?",
        (status, (message or "")[:2000], json.dumps({**result, "outcome": outcome}), _now(), job["id"]),
    )
    _drop_secrets(job["id"])


def finish(job_id: str, worker: str, status: str, outcome: str, message: str, result: dict[str, Any]) -> dict[str, Any]:
    if status not in ("done", "failed", "cancelled"):
        raise JobError("status must be done, failed or cancelled.")
    result = result if isinstance(result, dict) else {}
    conn = db._connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM tc_jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise JobError("Unknown job.", 404)
        job = dict(row)
        if job["status"] != "running" or job["worker"] != worker:
            raise JobError("That job is not running on this worker.", 409)
        if status == "done":
            # A "done" that does not carry a usable outcome is not trusted.
            stage = job["stage"]
            ok = (
                (stage == "generate" and outcome in GENERATE_OUTCOMES)
                or (stage == "regenerate" and outcome in REGENERATE_OUTCOMES)
                or (stage == "remove" and outcome in REMOVE_OUTCOMES)
                or (stage == "validate" and (outcome in VALIDATE_OUTCOMES or outcome in VALIDATE_NO_CHANGE))
                or (stage == "include" and outcome == "pushed" and valid_branch(str(result.get("branch") or "")))
            )
            if not ok:
                status, message = "failed", f"The worker reported an unusable result ({outcome or 'none'}). {message}"
        _close(conn, job, status, outcome, message, result)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()
    return get_job(job_id)
