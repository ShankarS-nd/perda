"""
database.py — SQLite persistence for script run history and workflows.

Provides:
  init_db()          → create all tables if they don't exist
  save_script_run()  → insert a new execution record
  get_recent_runs()  → fetch the last N execution records

  Workflow CRUD:
  save_workflow()          → upsert a workflow definition
  get_workflows()          → list all workflows
  get_workflow_by_id()     → single workflow
  delete_workflow()        → remove a workflow

  Workflow run tracking:
  create_workflow_run()    → start a workflow execution
  update_workflow_run()    → update run status/end_time
  save_workflow_step()     → insert a step result
  update_workflow_step()   → update a step result
  get_workflow_runs()      → last N runs
  get_workflow_run()       → single run + steps

  Review bench (generated regression testcases awaiting sign-off):
  import_review_testcases()  → upsert a pushed batch, preserving review state
  get_review_testcases()     → every testcase with its comments
  set_review_status()        → mark reviewed / back to pending
  add_review_comment()       → post a comment on a testcase
  set_comment_resolved()     → resolve / reopen a comment
  delete_review_comment()    → remove a comment
  save_review_run()          → record an execution of a testcase on a device
  get_review_runs()          → runs for a testcase, newest first
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DB_PATH = Path(__file__).resolve().parent / "perda.db"

# ---------------------------------------------------------------------------
# Initialisation
# ---------------------------------------------------------------------------


def _connect() -> sqlite3.Connection:
    """Return a new connection with row-factory enabled."""
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")  # better concurrent-read perf
    return conn


def init_db() -> None:
    """Create all tables if they do not already exist."""
    conn = _connect()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS script_runs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                script_name     TEXT     NOT NULL,
                arguments       TEXT     NOT NULL DEFAULT '{}',
                stdout          TEXT     NOT NULL DEFAULT '',
                stderr          TEXT     NOT NULL DEFAULT '',
                status          TEXT     NOT NULL DEFAULT 'unknown',
                execution_time  REAL     NOT NULL DEFAULT 0.0,
                timestamp       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS workflows (
                id               INTEGER  PRIMARY KEY AUTOINCREMENT,
                name             TEXT     NOT NULL,
                description      TEXT     NOT NULL DEFAULT '',
                definition_json  TEXT     NOT NULL DEFAULT '{}',
                created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS workflow_runs (
                id           INTEGER  PRIMARY KEY AUTOINCREMENT,
                workflow_id  INTEGER  NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
                status       TEXT     NOT NULL DEFAULT 'running',
                start_time   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                end_time     DATETIME
            );

            CREATE TABLE IF NOT EXISTS workflow_steps (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id          INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
                node_id         TEXT    NOT NULL,
                script_name     TEXT    NOT NULL,
                status          TEXT    NOT NULL DEFAULT 'pending',
                stdout          TEXT    NOT NULL DEFAULT '',
                stderr          TEXT    NOT NULL DEFAULT '',
                execution_time  REAL    NOT NULL DEFAULT 0.0,
                retry_attempts  INTEGER NOT NULL DEFAULT 0,
                output_json     TEXT    NOT NULL DEFAULT '{}'
            );

            -- Review bench -------------------------------------------------
            -- One row per generated testcase awaiting human sign-off. `tc_key`
            -- is the stable "DT-2029:TC_5001" identity, so re-pushing a ticket
            -- updates the metadata in place and never disturbs review state.
            CREATE TABLE IF NOT EXISTS review_testcases (
                id              INTEGER  PRIMARY KEY AUTOINCREMENT,
                tc_key          TEXT     NOT NULL UNIQUE,
                dt              TEXT     NOT NULL,
                dt_url          TEXT     NOT NULL DEFAULT '',
                dt_summary      TEXT     NOT NULL DEFAULT '',
                dt_description  TEXT     NOT NULL DEFAULT '',
                component       TEXT     NOT NULL DEFAULT '',
                service         TEXT     NOT NULL DEFAULT '',
                priority        TEXT     NOT NULL DEFAULT '',
                jira_status     TEXT     NOT NULL DEFAULT '',
                fix_version     TEXT     NOT NULL DEFAULT '',
                tc_id           TEXT     NOT NULL DEFAULT '',
                tc_file         TEXT     NOT NULL DEFAULT '',
                tc_path         TEXT     NOT NULL DEFAULT '',
                tc_summary      TEXT     NOT NULL DEFAULT '',
                source          TEXT     NOT NULL DEFAULT '',
                flag            TEXT,
                report_url      TEXT,
                review_status   TEXT     NOT NULL DEFAULT 'pending',
                reviewed_by     TEXT,
                reviewed_at     DATETIME,
                pushed_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS review_comments (
                id           INTEGER  PRIMARY KEY AUTOINCREMENT,
                testcase_id  INTEGER  NOT NULL REFERENCES review_testcases(id) ON DELETE CASCADE,
                author       TEXT     NOT NULL DEFAULT '',
                kind         TEXT     NOT NULL DEFAULT 'change',
                body         TEXT     NOT NULL DEFAULT '',
                resolved     INTEGER  NOT NULL DEFAULT 0,
                resolved_by  TEXT,
                resolved_at  DATETIME,
                created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_review_comments_tc
                ON review_comments(testcase_id);

            -- One row per execution. The framework's own report is served by a
            -- short-lived Flask process on whichever machine ran the suite, so a
            -- link to it dies with the run; the verdict and per-step results are
            -- copied here instead and stay readable for good.
            CREATE TABLE IF NOT EXISTS review_runs (
                id            INTEGER  PRIMARY KEY AUTOINCREMENT,
                testcase_id   INTEGER  NOT NULL REFERENCES review_testcases(id) ON DELETE CASCADE,
                device_id     TEXT     NOT NULL DEFAULT '',
                device_ip     TEXT     NOT NULL DEFAULT '',
                device_type   TEXT     NOT NULL DEFAULT '',
                build         TEXT     NOT NULL DEFAULT '',
                status        TEXT     NOT NULL DEFAULT 'unknown',
                -- 'fixed'  = a device carrying the fix; the run should Pass.
                -- 'prefix' = a device on a build predating the fix; the run is
                -- EXPECTED to Fail, and that failure is the evidence the test
                -- actually detects the bug rather than passing vacuously.
                device_stage  TEXT     NOT NULL DEFAULT 'fixed',
                steps_total   INTEGER  NOT NULL DEFAULT 0,
                steps_passed  INTEGER  NOT NULL DEFAULT 0,
                steps_failed  INTEGER  NOT NULL DEFAULT 0,
                duration      TEXT     NOT NULL DEFAULT '',
                started_at    TEXT     NOT NULL DEFAULT '',
                ended_at      TEXT     NOT NULL DEFAULT '',
                steps_json    TEXT     NOT NULL DEFAULT '[]',
                collection    TEXT     NOT NULL DEFAULT '',
                report_url    TEXT,
                created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_review_runs_tc
                ON review_runs(testcase_id);
        """)

        # CREATE TABLE IF NOT EXISTS leaves an already-created table alone, so a
        # column added after a database exists has to be migrated in by hand.
        have = {r["name"] for r in conn.execute("PRAGMA table_info(review_runs)")}
        if "device_stage" not in have:
            conn.execute(
                "ALTER TABLE review_runs "
                "ADD COLUMN device_stage TEXT NOT NULL DEFAULT 'fixed'"
            )

        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


def save_script_run(
    script_name: str,
    arguments: dict[str, Any],
    stdout: str,
    stderr: str,
    status: str,
    execution_time: float,
) -> int:
    """
    Insert a completed script execution into the database.

    Returns the row id of the new record.
    """
    conn = _connect()
    try:
        cur = conn.execute(
            """
            INSERT INTO script_runs
                (script_name, arguments, stdout, stderr, status, execution_time, timestamp)
            VALUES
                (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                script_name,
                json.dumps(arguments),
                stdout,
                stderr,
                status,
                round(execution_time, 3),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
        return cur.lastrowid or 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


def get_recent_runs(limit: int = 50) -> list[dict[str, Any]]:
    """Return the *limit* most recent script runs, newest first."""
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT id, script_name, arguments, stdout, stderr,
                   status, execution_time, timestamp
            FROM script_runs
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_run_by_id(run_id: int) -> dict[str, Any] | None:
    """Return a single run by its id, or None."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM script_runs WHERE id = ?", (run_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# ===========================================================================
# Workflow CRUD
# ===========================================================================


def save_workflow(
    name: str,
    description: str,
    definition_json: dict[str, Any],
    workflow_id: int | None = None,
) -> int:
    """Insert or update a workflow.  Returns the workflow id."""
    conn = _connect()
    now = datetime.now(timezone.utc).isoformat()
    try:
        if workflow_id:
            conn.execute(
                """
                UPDATE workflows
                SET name = ?, description = ?, definition_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (name, description, json.dumps(definition_json), now, workflow_id),
            )
            conn.commit()
            return workflow_id
        else:
            cur = conn.execute(
                """
                INSERT INTO workflows (name, description, definition_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (name, description, json.dumps(definition_json), now, now),
            )
            conn.commit()
            return cur.lastrowid or 0
    finally:
        conn.close()


def get_workflows() -> list[dict[str, Any]]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, name, description, definition_json, created_at, updated_at "
            "FROM workflows ORDER BY updated_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_workflow_by_id(workflow_id: int) -> dict[str, Any] | None:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM workflows WHERE id = ?", (workflow_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_workflow(workflow_id: int) -> bool:
    conn = _connect()
    try:
        cur = conn.execute("DELETE FROM workflows WHERE id = ?", (workflow_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ===========================================================================
# Workflow-run tracking
# ===========================================================================


def create_workflow_run(workflow_id: int) -> int:
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO workflow_runs (workflow_id, status, start_time) VALUES (?, 'running', ?)",
            (workflow_id, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        return cur.lastrowid or 0
    finally:
        conn.close()


def update_workflow_run(run_id: int, status: str) -> None:
    conn = _connect()
    try:
        conn.execute(
            "UPDATE workflow_runs SET status = ?, end_time = ? WHERE id = ?",
            (status, datetime.now(timezone.utc).isoformat(), run_id),
        )
        conn.commit()
    finally:
        conn.close()


def save_workflow_step(
    run_id: int,
    node_id: str,
    script_name: str,
    status: str = "pending",
) -> int:
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO workflow_steps (run_id, node_id, script_name, status) VALUES (?, ?, ?, ?)",
            (run_id, node_id, script_name, status),
        )
        conn.commit()
        return cur.lastrowid or 0
    finally:
        conn.close()


def update_workflow_step(
    step_id: int,
    *,
    status: str | None = None,
    stdout: str | None = None,
    stderr: str | None = None,
    execution_time: float | None = None,
    retry_attempts: int | None = None,
    output_json: dict[str, Any] | None = None,
) -> None:
    conn = _connect()
    try:
        parts: list[str] = []
        vals: list[Any] = []
        if status is not None:
            parts.append("status = ?"); vals.append(status)
        if stdout is not None:
            parts.append("stdout = ?"); vals.append(stdout)
        if stderr is not None:
            parts.append("stderr = ?"); vals.append(stderr)
        if execution_time is not None:
            parts.append("execution_time = ?"); vals.append(round(execution_time, 3))
        if retry_attempts is not None:
            parts.append("retry_attempts = ?"); vals.append(retry_attempts)
        if output_json is not None:
            parts.append("output_json = ?"); vals.append(json.dumps(output_json))
        if not parts:
            return
        vals.append(step_id)
        conn.execute(f"UPDATE workflow_steps SET {', '.join(parts)} WHERE id = ?", vals)
        conn.commit()
    finally:
        conn.close()


def get_workflow_runs(workflow_id: int | None = None, limit: int = 50) -> list[dict[str, Any]]:
    conn = _connect()
    try:
        if workflow_id:
            rows = conn.execute(
                "SELECT wr.*, w.name as workflow_name FROM workflow_runs wr "
                "JOIN workflows w ON w.id = wr.workflow_id "
                "WHERE wr.workflow_id = ? ORDER BY wr.id DESC LIMIT ?",
                (workflow_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT wr.*, w.name as workflow_name FROM workflow_runs wr "
                "JOIN workflows w ON w.id = wr.workflow_id "
                "ORDER BY wr.id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_workflow_run_detail(run_id: int) -> dict[str, Any] | None:
    conn = _connect()
    try:
        run_row = conn.execute(
            "SELECT wr.*, w.name as workflow_name, w.definition_json "
            "FROM workflow_runs wr JOIN workflows w ON w.id = wr.workflow_id "
            "WHERE wr.id = ?",
            (run_id,),
        ).fetchone()
        if not run_row:
            return None
        result = dict(run_row)
        steps = conn.execute(
            "SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY id",
            (run_id,),
        ).fetchall()
        result["steps"] = [dict(s) for s in steps]
        return result
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Review bench
# ---------------------------------------------------------------------------

# Metadata columns are owned by the generator and refreshed on every push;
# review state (status / who / when, and all comments) is owned by the
# reviewers and must survive a re-push untouched.
_REVIEW_META_COLUMNS = (
    "dt", "dt_url", "dt_summary", "dt_description", "component", "service",
    "priority", "jira_status", "fix_version", "tc_id", "tc_file", "tc_path",
    "tc_summary", "source", "flag", "report_url",
)


def import_review_testcases(items: list[dict[str, Any]]) -> dict[str, int]:
    """
    Upsert a pushed batch of generated testcases.

    Each item is keyed by `tc_key` ("DT-2029:TC_5001"). An unseen key is
    inserted as pending; a known key has only its metadata refreshed, so a
    reviewer's sign-off and comments are never lost by re-pushing a ticket.

    Returns {"added": n, "updated": n}.
    """
    added = updated = 0
    now = datetime.now(timezone.utc).isoformat()
    conn = _connect()
    try:
        for item in items:
            key = str(item.get("tc_key") or "").strip()
            if not key:
                continue
            values = [item.get(col) if item.get(col) is not None else
                      (None if col in ("flag", "report_url") else "")
                      for col in _REVIEW_META_COLUMNS]

            row = conn.execute(
                "SELECT id FROM review_testcases WHERE tc_key = ?", (key,)
            ).fetchone()

            if row:
                assignments = ", ".join(f"{c} = ?" for c in _REVIEW_META_COLUMNS)
                conn.execute(
                    f"UPDATE review_testcases SET {assignments}, updated_at = ? WHERE tc_key = ?",
                    (*values, now, key),
                )
                updated += 1
            else:
                cols = ", ".join(_REVIEW_META_COLUMNS)
                marks = ", ".join("?" for _ in _REVIEW_META_COLUMNS)
                conn.execute(
                    f"""
                    INSERT INTO review_testcases
                        (tc_key, {cols}, review_status, pushed_at, updated_at)
                    VALUES (?, {marks}, 'pending', ?, ?)
                    """,
                    (key, *values, now, now),
                )
                added += 1
        conn.commit()
        return {"added": added, "updated": updated}
    finally:
        conn.close()


def get_review_testcases() -> list[dict[str, Any]]:
    """Every testcase on the bench, each with its comment thread attached."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM review_testcases ORDER BY dt, tc_id"
        ).fetchall()
        cases = [dict(r) for r in rows]

        threads: dict[int, list[dict[str, Any]]] = {}
        for c in conn.execute(
            "SELECT * FROM review_comments ORDER BY created_at ASC"
        ).fetchall():
            comment = dict(c)
            comment["resolved"] = bool(comment["resolved"])
            threads.setdefault(comment["testcase_id"], []).append(comment)

        for case in cases:
            case["comments"] = threads.get(case["id"], [])
        return cases
    finally:
        conn.close()


def set_review_status(tc_key: str, status: str, reviewer: str | None) -> bool:
    """Mark a testcase reviewed, or send it back to the queue."""
    reviewed = status == "reviewed"
    conn = _connect()
    try:
        cur = conn.execute(
            """
            UPDATE review_testcases
               SET review_status = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
             WHERE tc_key = ?
            """,
            (
                "reviewed" if reviewed else "pending",
                reviewer if reviewed else None,
                datetime.now(timezone.utc).isoformat() if reviewed else None,
                datetime.now(timezone.utc).isoformat(),
                tc_key,
            ),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def add_review_comment(tc_key: str, author: str, kind: str, body: str) -> dict[str, Any] | None:
    """Post a comment on a testcase. Returns the stored comment, or None if unknown."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id FROM review_testcases WHERE tc_key = ?", (tc_key,)
        ).fetchone()
        if not row:
            return None
        cur = conn.execute(
            """
            INSERT INTO review_comments (testcase_id, author, kind, body, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (row["id"], author, kind, body, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        saved = conn.execute(
            "SELECT * FROM review_comments WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        comment = dict(saved)
        comment["resolved"] = bool(comment["resolved"])
        return comment
    finally:
        conn.close()


def set_comment_resolved(comment_id: int, resolved: bool, actor: str | None) -> bool:
    """Resolve a comment (keeping it on the record) or reopen it."""
    conn = _connect()
    try:
        cur = conn.execute(
            """
            UPDATE review_comments
               SET resolved = ?, resolved_by = ?, resolved_at = ?
             WHERE id = ?
            """,
            (
                1 if resolved else 0,
                actor if resolved else None,
                datetime.now(timezone.utc).isoformat() if resolved else None,
                comment_id,
            ),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_review_comment(comment_id: int) -> bool:
    """Remove a comment outright. Deletion is the one action Undo cannot reverse."""
    conn = _connect()
    try:
        cur = conn.execute("DELETE FROM review_comments WHERE id = ?", (comment_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_review_testcase(tc_key: str) -> dict[str, int] | None:
    """
    Remove a testcase from the bench along with its comments and recorded runs.

    Used to retire something that should never have been queued for sign-off: a
    candidate with no passing run, or one superseded by existing coverage.

    The child tables declare ON DELETE CASCADE, but connections here do not set
    `PRAGMA foreign_keys=ON`, so SQLite never enforces it — the children are
    deleted explicitly rather than left orphaned. Returns None if `tc_key` is
    unknown, else the counts removed.
    """
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id FROM review_testcases WHERE tc_key = ?", (tc_key,)
        ).fetchone()
        if row is None:
            return None
        tc_id = row["id"]
        runs = conn.execute(
            "DELETE FROM review_runs WHERE testcase_id = ?", (tc_id,)
        ).rowcount
        comments = conn.execute(
            "DELETE FROM review_comments WHERE testcase_id = ?", (tc_id,)
        ).rowcount
        conn.execute("DELETE FROM review_testcases WHERE id = ?", (tc_id,))
        conn.commit()
        return {"runs": runs, "comments": comments}
    finally:
        conn.close()


def save_review_run(tc_key: str, run: dict[str, Any]) -> dict[str, Any] | None:
    """
    Record one execution of a testcase against a device.

    Steps are stored verbatim as JSON so the report can be rebuilt exactly as the
    framework reported it, without keeping the framework's report server alive.
    """
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id FROM review_testcases WHERE tc_key = ?", (tc_key,)
        ).fetchone()
        if not row:
            return None

        steps = run.get("steps") or []
        passed = sum(1 for s in steps for v in s.values() if v == "Pass")
        failed = sum(1 for s in steps for v in s.values() if v == "Fail")

        cur = conn.execute(
            """
            INSERT INTO review_runs
                (testcase_id, device_id, device_ip, device_type, build, status,
                 device_stage, steps_total, steps_passed, steps_failed, duration,
                 started_at, ended_at, steps_json, collection, report_url, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                row["id"],
                run.get("device_id", ""), run.get("device_ip", ""),
                run.get("device_type", ""), run.get("build", ""),
                run.get("status", "unknown"),
                "prefix" if run.get("device_stage") == "prefix" else "fixed",
                len(steps), passed, failed,
                run.get("duration", ""),
                run.get("started_at", ""), run.get("ended_at", ""),
                json.dumps(steps), run.get("collection", ""),
                run.get("report_url"),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
        saved = conn.execute("SELECT * FROM review_runs WHERE id = ?", (cur.lastrowid,)).fetchone()
        out = dict(saved)
        out["steps"] = json.loads(out.pop("steps_json") or "[]")
        return out
    finally:
        conn.close()


def get_review_runs(tc_key: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """
    Runs for one testcase (or the latest across all), newest first.

    Fixed-device runs sort ahead of pre-fix ones. Callers treat the first row for
    a testcase as its headline verdict, and a pre-fix run is *expected* to fail —
    letting one lead would show a green, signed-off testcase as failing purely
    because its bug-detection evidence was recorded most recently. Pre-fix runs
    stay in the history right behind, and keep their own report.
    """
    conn = _connect()
    try:
        order = "CASE WHEN {p}device_stage = 'prefix' THEN 1 ELSE 0 END ASC, {p}created_at DESC"
        if tc_key:
            rows = conn.execute(
                f"""
                SELECT r.* FROM review_runs r
                  JOIN review_testcases t ON t.id = r.testcase_id
                 WHERE t.tc_key = ?
                 ORDER BY {order.format(p='r.')} LIMIT ?
                """,
                (tc_key, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT * FROM review_runs ORDER BY {order.format(p='')} LIMIT ?",
                (limit,),
            ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["steps"] = json.loads(d.pop("steps_json") or "[]")
            out.append(d)
        return out
    finally:
        conn.close()
