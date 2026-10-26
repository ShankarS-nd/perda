"""
Jira client for the Release Tickets page.

Fetches the tickets of one fix version (optionally narrowed to a project and
sprint) and reduces each to the fields the table shows. Credentials come from
backend/.env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (an Atlassian API token).
"""

import os
import re
from typing import Any

import requests

JIRA_BASE_URL = os.getenv("JIRA_BASE_URL", "https://netradyne.atlassian.net").rstrip("/")
DEFAULT_PROJECT = "Device_Tracker"

# Test-case tickets live in their own project and hang off the bug/story with a
# "Test" link (e.g. DT-5192 → TC-5204, TC-5205).
TC_PROJECT = os.getenv("JIRA_TC_PROJECT", "TC")

_FIELDS = [
    "summary", "issuetype", "status", "resolution", "assignee", "labels",
    "issuelinks", "fixVersions",
]
_PAGE = 100
_MAX_TICKETS = 1000


class JiraError(Exception):
    """Raised with a message that is safe to show the user."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_jql(fix_version: str, project: str, sprint: str) -> str:
    clauses = [f"fixVersion = {_quote(fix_version)}"]
    if project:
        clauses.append(f"project = {_quote(project)}")
    if sprint:
        # Sprint ids are numeric; anything else is a name.
        clauses.append(f"sprint = {sprint}" if sprint.isdigit() else f"sprint = {_quote(sprint)}")
    return " AND ".join(clauses) + " ORDER BY key DESC"


def _auth() -> tuple[str, str]:
    email = os.getenv("JIRA_EMAIL", "").strip()
    token = os.getenv("JIRA_API_TOKEN", "").strip()
    if not email or not token:
        raise JiraError(
            "Jira is not connected: set JIRA_EMAIL and JIRA_API_TOKEN in backend/.env "
            "and restart the backend.",
            status=503,
        )
    return email, token


def _tc_links(links: list[dict[str, Any]]) -> list[str]:
    keys = []
    for link in links or []:
        other = link.get("outwardIssue") or link.get("inwardIssue") or {}
        key = other.get("key", "")
        if re.match(rf"^{re.escape(TC_PROJECT)}-\d+$", key):
            keys.append(key)
    return sorted(set(keys), key=lambda k: int(k.rsplit("-", 1)[1]))


def _shape(issue: dict[str, Any]) -> dict[str, Any]:
    f = issue.get("fields") or {}
    return {
        "key": issue["key"],
        "summary": f.get("summary") or "",
        "issue_type": (f.get("issuetype") or {}).get("name", ""),
        "status": (f.get("status") or {}).get("name", ""),
        "resolution": (f.get("resolution") or {}).get("name", ""),
        "assignee": (f.get("assignee") or {}).get("displayName", ""),
        "labels": f.get("labels") or [],
        "tc_tickets": _tc_links(f.get("issuelinks")),
    }


def fetch_tickets(fix_version: str, project: str = DEFAULT_PROJECT, sprint: str = "") -> list[dict[str, Any]]:
    """Every ticket matching the fix version / project / sprint, shaped for the table."""
    jql = build_jql(fix_version, project, sprint)
    tickets: list[dict[str, Any]] = []
    token: str | None = None

    while len(tickets) < _MAX_TICKETS:
        body: dict[str, Any] = {"jql": jql, "fields": _FIELDS, "maxResults": _PAGE}
        if token:
            body["nextPageToken"] = token
        try:
            resp = requests.post(
                f"{JIRA_BASE_URL}/rest/api/3/search/jql",
                json=body, auth=_auth(), timeout=30,
                headers={"Accept": "application/json"},
            )
        except requests.RequestException as exc:
            raise JiraError(f"Could not reach Jira: {exc}")

        if resp.status_code in (401, 403):
            raise JiraError("Jira rejected the credentials — check JIRA_EMAIL and JIRA_API_TOKEN.", status=401)
        if resp.status_code == 400:
            # Jira's message names the bad field/value, e.g. an unknown fix version.
            msgs = resp.json().get("errorMessages") or []
            raise JiraError(msgs[0] if msgs else "Jira could not run that query.", status=400)
        if not resp.ok:
            raise JiraError(f"Jira returned HTTP {resp.status_code}.")

        data = resp.json()
        tickets.extend(_shape(i) for i in data.get("issues", []))
        token = data.get("nextPageToken")
        if not token or data.get("isLast"):
            break
    return tickets
