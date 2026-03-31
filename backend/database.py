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
        """)
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
