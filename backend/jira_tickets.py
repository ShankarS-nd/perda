"""
Jira client for the Release Tickets page.

Fetches the tickets of one fix version (optionally narrowed to a project and
sprint) and reduces each to the fields the table shows. Credentials come from
backend/.env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (an Atlassian API token).
"""

import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import requests

JIRA_BASE_URL = os.getenv("JIRA_BASE_URL", "https://netradyne.atlassian.net").rstrip("/")
DEFAULT_PROJECT = "Device_Tracker"
# The key behind that project name, used by the version and board lookups.
PROJECT_KEY = os.getenv("JIRA_PROJECT_KEY", "DT")

# Test-case tickets live in their own project and hang off the bug/story with a
# "Test" link (e.g. DT-5192 → TC-5204, TC-5205).
TC_PROJECT = os.getenv("JIRA_TC_PROJECT", "TC")

# Jira's development panel is read through the (undocumented but stable)
# dev-status API; this is the application type of the GitHub-for-Jira app.
PR_APP_TYPE = os.getenv("JIRA_PR_APP_TYPE", "oAuth-com.github.integration.production")

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
        "id": issue.get("id", ""),
        "summary": f.get("summary") or "",
        "issue_type": (f.get("issuetype") or {}).get("name", ""),
        "status": (f.get("status") or {}).get("name", ""),
        "resolution": (f.get("resolution") or {}).get("name", ""),
        "assignee": (f.get("assignee") or {}).get("displayName", ""),
        "labels": f.get("labels") or [],
        "tc_tickets": _tc_links(f.get("issuelinks")),
    }


def fetch_tickets(fix_version: str, project: str = DEFAULT_PROJECT, sprint: str = "") -> list[dict[str, Any]]:
    """Every ticket matching the fix version / project / sprint, shaped for the table.

    Pull requests are not included: they cost one Jira call per ticket, so the page
    asks for them separately (fetch_prs) and fills the column in as they arrive.
    """
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

    for t in tickets:
        _issue_ids[t["key"]] = t.pop("id", "")
    return tickets


# ---------------------------------------------------------------------------
# Pull requests (Jira development panel)
# ---------------------------------------------------------------------------

_PR_TTL = 60
_issue_ids: dict[str, str] = {}  # ticket key → Jira's numeric id, which the dev-status API needs
_pr_cache: dict[str, tuple[float, list[dict[str, Any]] | None]] = {}


def _fetch_prs(issue_id: str) -> list[dict[str, Any]] | None:
    """PRs linked to one issue, or None if Jira could not say (shown as unknown, not as 'no PRs')."""
    hit = _pr_cache.get(issue_id)
    if hit and time.time() - hit[0] < _PR_TTL:
        return hit[1]
    prs: list[dict[str, Any]] | None
    try:
        resp = requests.get(
            f"{JIRA_BASE_URL}/rest/dev-status/latest/issue/detail",
            params={"issueId": issue_id, "applicationType": PR_APP_TYPE, "dataType": "pullrequest"},
            auth=_auth(), timeout=30, headers={"Accept": "application/json"},
        )
        if not resp.ok:
            prs = None
        else:
            prs = []
            for block in resp.json().get("detail", []):
                for pr in block.get("pullRequests", []):
                    prs.append({
                        "id": pr.get("id", ""),
                        "title": pr.get("name", ""),
                        "url": pr.get("url", ""),
                        "status": (pr.get("status") or "").upper(),
                        "repo": (pr.get("repositoryName") or "").split("/")[-1],
                        "author": (pr.get("author") or {}).get("name", ""),
                        "target": (pr.get("destination") or {}).get("branch", ""),
                    })
    except (requests.RequestException, ValueError):
        prs = None
    _pr_cache[issue_id] = (time.time(), prs)
    return prs


def _resolve_ids(keys: list[str]) -> None:
    """Look up Jira's numeric ids for keys this process has not seen (the page's two
    requests can land on different server workers)."""
    for n in range(0, len(keys), _PAGE):
        chunk = keys[n:n + _PAGE]
        resp = requests.post(
            f"{JIRA_BASE_URL}/rest/api/3/search/jql",
            json={"jql": "key in (" + ",".join(_quote(k) for k in chunk) + ")", "fields": ["summary"], "maxResults": _PAGE},
            auth=_auth(), timeout=30, headers={"Accept": "application/json"},
        )
        if resp.ok:
            for issue in resp.json().get("issues", []):
                _issue_ids[issue["key"]] = issue["id"]


_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]*-\d+$")


def fetch_prs(keys: list[str]) -> dict[str, list[dict[str, Any]] | None]:
    """PRs for the given ticket keys (None per key where Jira could not say)."""
    _auth()  # fail with the friendly message before fanning out
    keys = [k for k in dict.fromkeys(keys) if _KEY_RE.match(k)]
    missing = [k for k in keys if k not in _issue_ids]
    if missing:
        try:
            _resolve_ids(missing)
        except requests.RequestException:
            pass
    known = [k for k in keys if _issue_ids.get(k)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        out = dict(zip(known, pool.map(lambda k: _fetch_prs(_issue_ids[k]), known)))
    return {k: out.get(k) for k in keys}


# ---------------------------------------------------------------------------
# Dropdown options
# ---------------------------------------------------------------------------

_OPTIONS_TTL = 300  # seconds — versions and sprints change rarely
_options_cache: tuple[float, dict[str, Any]] | None = None


def _get(path: str, **params: Any) -> Any:
    try:
        resp = requests.get(
            f"{JIRA_BASE_URL}{path}", params=params, auth=_auth(), timeout=30,
            headers={"Accept": "application/json"},
        )
    except requests.RequestException as exc:
        raise JiraError(f"Could not reach Jira: {exc}")
    if resp.status_code in (401, 403):
        raise JiraError("Jira rejected the credentials — check JIRA_EMAIL and JIRA_API_TOKEN.", status=401)
    if not resp.ok:
        raise JiraError(f"Jira returned HTTP {resp.status_code}.")
    return resp.json()


def _version_order(name: str) -> tuple:
    """Release builds ("x.6.19.rc.1") first, newest first; everything else after, A–Z."""
    m = re.match(r"^x\.(\d+)\.(\d+)\.rc\.(\d+)", name)
    if m:
        return (0, tuple(-int(g) for g in m.groups()), name)
    return (1, (), name.lower())


def fetch_options() -> dict[str, list[dict[str, Any]]]:
    """Fix versions of the project and the sprints of its boards, for the page's dropdowns."""
    global _options_cache
    if _options_cache and time.time() - _options_cache[0] < _OPTIONS_TTL:
        return _options_cache[1]

    versions = [
        {"id": v["id"], "name": v["name"], "released": bool(v.get("released"))}
        for v in _get(f"/rest/api/3/project/{PROJECT_KEY}/versions")
        if not v.get("archived")
    ]
    versions.sort(key=lambda v: _version_order(v["name"]))

    sprints: dict[int, dict[str, Any]] = {}
    for board in _get("/rest/agile/1.0/board", projectKeyOrId=PROJECT_KEY).get("values", []):
        if board.get("type") != "scrum":  # kanban boards have no sprints
            continue
        start = 0
        while True:
            page = _get(f"/rest/agile/1.0/board/{board['id']}/sprint", startAt=start, maxResults=50)
            values = page.get("values", [])
            for sp in values:
                sprints[sp["id"]] = {"id": sp["id"], "name": sp["name"], "state": sp.get("state", "")}
            if not values or page.get("isLast"):
                break
            start += len(values)

    # Newest first: ids only ever grow.
    out = {"versions": versions, "sprints": sorted(sprints.values(), key=lambda s: -s["id"])}
    _options_cache = (time.time(), out)
    return out
