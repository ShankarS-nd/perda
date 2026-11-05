"""
Release Notes Sync — builds what the dashboard will post to the release-notes app.

Three pure-ish pieces, none of which write anywhere:

  * shape_summary()   turns the /test-report-summary result into the agreed
                      `testAutomationSummary[<device>]` payload (regressions only).
  * change log        compares two refs per repo through GitHub's compare API and
                      renders the commits as the plain text the release notes hold
                      (`testAutomationChangeLog`, capped at 20,000 characters).
  * build_dry_run()   assembles the exact PATCH request a later "push" step will send.

Nothing here talks to the release-notes app's write API: authentication is still to be
agreed with its owners. Reads (RC details, for the default tags) are unauthenticated.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any, Callable

import requests

RELEASE_NOTES_URL = os.getenv("RELEASE_NOTES_URL", "http://172.16.23.15:5050/release-notes").rstrip("/")
GITHUB_ORG = os.getenv("GITHUB_ORG", "netradyne")
CHANGELOG_LIMIT = 20000          # the release notes' maxLength for testAutomationChangeLog
MAX_COMMITS_PER_REPO = 2000
ERROR_TEXT_LIMIT = 1000
SCHEMA_VERSION = 1

# Release-notes product line → dashboard platform code. D810 (Octo) has no dashboard
# platform yet, so it is listed but cannot be compared.
DEVICE_MAP: dict[str, str | None] = {
    "D450_US": "B3_US",
    "D450_IN": "B3_IN",
    "D215_US": "K2_US",
    "D215_IN": "K2_IN",
    "D430_US": "B2_US",
    "D210_US": "K1_US",
    "D210_UK": "K1_UK",
    "D810_US": None,
}

# Tag keys in a product line's `buildBranches` → GitHub repo.
TAG_REPOS = {
    "ND_CORE_UTILS_TAG": "nd_core_utils",
    "ND_DEVICE_SERVICES_TAG": "nd_device_services",
    "SHIELD_TAG": "shield",
    "ND_CONNECTION_MGR_TAG": "nd_connection_mgr",
    "ND_VDM_TAG": "nd_vdm",
    "ND_AUDIO_FILES_TAG": "nd_audio_files",
    "DEVICE_BUILD_TAG": "device-build",
}

_JIRA_KEY = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")


class SyncError(Exception):
    """Raised with a message that is safe to show the user."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------

def devices() -> list[dict]:
    return [
        {"device": d, "platform": p, "supported": p is not None}
        for d, p in DEVICE_MAP.items()
    ]


def platform_for(device: str) -> str:
    if device not in DEVICE_MAP:
        raise SyncError(f"Unknown device '{device}'. Valid: {', '.join(DEVICE_MAP)}", 400)
    platform = DEVICE_MAP[device]
    if platform is None:
        raise SyncError(f"{device} has no dashboard platform yet, so it cannot be compared.", 400)
    return platform


# ---------------------------------------------------------------------------
# Test report summary → payload
# ---------------------------------------------------------------------------

def _overview(o: dict) -> dict:
    return {
        "total": o.get("total", 0),
        "pass": o.get("pass", 0),
        "pass_pct": o.get("pass_pct", 0.0),
        "known_failures": o.get("known_failures", 0),
        "unknown_failures": o.get("unknown_failures", 0),
        "not_executed": o.get("not_executed", 0),
        "not_applicable": o.get("not_applicable", 0),
    }


def _regressions(block: dict) -> list[dict]:
    rows: list[dict] = []
    for known, key in ((True, "known_by_service"), (False, "unknown_by_service")):
        for service, tcs in (block.get(key) or {}).items():
            for tc in tcs:
                linked = (tc.get("linked") or "").strip()
                rows.append({
                    "tc_id": tc.get("tc_id", ""),
                    "service": service,
                    "name": tc.get("name", ""),
                    "error": (tc.get("error") or "")[:ERROR_TEXT_LIMIT],
                    "linked_issue": linked or None,
                    "known": known,
                })
    rows.sort(key=lambda r: (r["service"], r["tc_id"]))
    return rows


def shape_summary(
    report: dict,
    rc1_url: str = "",
    rc2_url: str = "",
    dashboard_url: str = "",
    now: Callable[[], datetime] | None = None,
) -> dict:
    """One device's `testAutomationSummary` entry from a /test-report-summary result."""
    now = now or (lambda: datetime.now(timezone.utc))
    reg = report.get("regressions") or {}
    pers = report.get("persistent_failures") or {}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "perda-dashboard",
        "reportLinks": {"current": rc2_url, "previous": rc1_url, "dashboard": dashboard_url},
        "builds": {
            "previous": {"label": report.get("rc1", ""), "ota": report.get("rc1_ota", "")},
            "current": {"label": report.get("rc2", ""), "ota": report.get("rc2_ota", "")},
        },
        "overview": {
            "previous": _overview(report.get("rc1_overview") or {}),
            "current": _overview(report.get("overview") or {}),
        },
        "comparison": {
            "regressions": {"known": reg.get("known_count", 0), "unknown": reg.get("unknown_count", 0)},
            "persistent_failures": {"known": pers.get("known_count", 0), "unknown": pers.get("unknown_count", 0)},
            "fixed": (report.get("fixed_tcs") or {}).get("count", 0),
            "stable": (report.get("stable_tcs") or {}).get("count", 0),
            "new": (report.get("new_tcs") or {}).get("count", 0),
            "removed": (report.get("removed_tcs") or {}).get("count", 0),
        },
        "regressions": _regressions(reg),
    }


# ---------------------------------------------------------------------------
# Default refs from the release-notes app
# ---------------------------------------------------------------------------

def previous_rc(rc: str) -> str | None:
    """x.6.17.rc.2 → x.6.17.rc.1; the first RC has no previous one."""
    m = re.match(r"^(.*\.rc\.)(\d+)$", rc.strip())
    if not m or int(m.group(2)) <= 1:
        return None
    return f"{m.group(1)}{int(m.group(2)) - 1}"


def parse_tags(build_branches: str) -> dict[str, str]:
    """'ND_CORE_UTILS_TAG=5.6.17.rc.1\\nSHIELD_TAG=…' → {repo: ref} for the tracked repos."""
    out: dict[str, str] = {}
    for line in (build_branches or "").splitlines():
        key, _, value = line.partition("=")
        repo = TAG_REPOS.get(key.strip())
        if repo and value.strip():
            out[repo] = value.strip()
    return out


def _product_line(rc_detail: dict, device: str) -> dict:
    lines = (rc_detail.get("overviewDetails") or {}).get("productLines") or []
    return next((p for p in lines if p.get("name") == device), {})


def refs_from_details(prev_detail: dict | None, cur_detail: dict | None, device: str) -> list[dict]:
    """[{repo, base, head}] — blank where the release notes do not have the tag yet."""
    prev = parse_tags(_product_line(prev_detail or {}, device).get("buildBranches", ""))
    cur = parse_tags(_product_line(cur_detail or {}, device).get("buildBranches", ""))
    return [
        {"repo": repo, "base": prev.get(repo, ""), "head": cur.get(repo, "")}
        for repo in TAG_REPOS.values()
    ]


def _fetch_rc_detail(edition: str, rc: str, project: str, get=requests.get) -> dict | None:
    resp = get(
        f"{RELEASE_NOTES_URL}/api/releases/{edition}/{rc}",
        params={"project": project} if project else None,
        timeout=30,
    )
    if resp.status_code == 404:
        return None
    if not resp.ok:
        raise SyncError(f"Release notes returned HTTP {resp.status_code} for {rc}.")
    return resp.json()


def default_refs(edition: str, rc: str, device: str, project: str = "DT", get=requests.get) -> dict:
    prev_rc = previous_rc(rc)
    try:
        cur = _fetch_rc_detail(edition, rc, project, get)
        prev = _fetch_rc_detail(edition, prev_rc, project, get) if prev_rc else None
    except requests.RequestException as exc:
        raise SyncError(f"Could not reach the release-notes app: {exc}") from exc
    if cur is None:
        raise SyncError(f"Release notes have no RC '{rc}' under {edition}.", 404)
    return {"previous_rc": prev_rc, "refs": refs_from_details(prev, cur, device)}


# ---------------------------------------------------------------------------
# Change log from GitHub
# ---------------------------------------------------------------------------

def _gh_headers(token: str) -> dict:
    return {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}


def fetch_compare(
    repo: str,
    base: str,
    head: str,
    token: str,
    get=requests.get,
    skip_merges: bool = True,
) -> dict:
    """Commits in base...head. Per-repo problems come back in `error`, not as exceptions;
    only bad credentials raise, because every repo would fail the same way."""
    result: dict[str, Any] = {
        "repo": repo, "base": base, "head": head, "commits": [], "total": 0,
        "compare_url": f"https://github.com/{GITHUB_ORG}/{repo}/compare/{base}...{head}", "error": "",
    }
    if not base or not head:
        result["error"] = "Needs both a base and a head ref."
        return result

    per_page, page, seen = 100, 1, 0
    while True:
        try:
            resp = get(
                f"https://api.github.com/repos/{GITHUB_ORG}/{repo}/compare/{base}...{head}",
                headers=_gh_headers(token), params={"per_page": per_page, "page": page}, timeout=60,
            )
        except requests.RequestException as exc:
            result["error"] = f"GitHub request failed: {exc}"
            return result
        if resp.status_code == 401:
            raise SyncError("GitHub rejected GITHUB_TOKEN (bad or expired credentials). Update it in backend/.env.", 502)
        if resp.status_code == 404:
            result["error"] = f"Ref not found: {base} or {head} does not exist in {repo} (or the token cannot see it)."
            return result
        if not resp.ok:
            result["error"] = f"GitHub returned HTTP {resp.status_code}."
            return result

        body = resp.json()
        commits = body.get("commits") or []
        result["total"] = body.get("total_commits", len(commits))
        for c in commits:
            seen += 1
            if skip_merges and len(c.get("parents") or []) > 1:
                continue
            message = (c.get("commit") or {}).get("message", "")
            subject = message.splitlines()[0].strip() if message else ""
            result["commits"].append({
                "sha": (c.get("sha") or "")[:7],
                "subject": subject,
                "author": ((c.get("commit") or {}).get("author") or {}).get("name", ""),
                "url": c.get("html_url", ""),
                "jira": sorted(set(_JIRA_KEY.findall(message))),
            })
        if len(commits) < per_page or seen >= result["total"] or seen >= MAX_COMMITS_PER_REPO:
            return result
        page += 1


def _commit_line(c: dict) -> str:
    jira = f" [{', '.join(c['jira'])}]" if c["jira"] else ""
    return f"- {c['subject']} ({c['sha']}){jira}"


def format_changelog(results: list[dict], limit: int = CHANGELOG_LIMIT) -> str:
    """Plain text grouped by repo, guaranteed to be at most `limit` characters."""
    parts: list[str] = []
    used = 0
    omitted_repos = 0

    def room(extra: int) -> bool:
        return used + extra <= limit - 160  # keep space for a closing note

    for r in results:
        if r.get("error") or not r["commits"]:
            continue
        header = f"## {r['repo']} ({r['base']} → {r['head']}) — {len(r['commits'])} commits"
        if not room(len(header) + 1):
            omitted_repos += 1
            continue
        block = [header]
        used += len(header) + 1
        shown = 0
        for c in r["commits"]:
            line = _commit_line(c)
            if not room(len(line) + 1):
                break
            block.append(line)
            used += len(line) + 1
            shown += 1
        if shown < len(r["commits"]):
            more = f"… +{len(r['commits']) - shown} more, see {r['compare_url']}"
            block.append(more)
            used += len(more) + 1
        parts.append("\n".join(block))

    text = "\n\n".join(parts)
    if omitted_repos:
        text += f"\n\n… {omitted_repos} more repo(s) omitted (length limit)."
    return text[:limit]


# ---------------------------------------------------------------------------
# Dry-run of the eventual push
# ---------------------------------------------------------------------------

def build_dry_run(edition: str, rc: str, project: str, summaries: dict[str, dict], changelog: str) -> dict:
    """The request a push would send. Never sent from here."""
    if not summaries and not changelog.strip():
        raise SyncError("Nothing to send: add at least one device summary or a change log.", 400)
    if len(changelog) > CHANGELOG_LIMIT:
        raise SyncError(f"Change log is {len(changelog)} characters; the release notes accept {CHANGELOG_LIMIT}.", 400)
    body: dict[str, Any] = {}
    if summaries:
        body["testAutomationSummary"] = summaries
    if changelog.strip():
        body["testAutomationChangeLog"] = changelog
    query = f"?project={project}" if project else ""
    return {
        "sent": False,
        "method": "PATCH",
        "url": f"{RELEASE_NOTES_URL}/api/releases/{edition}/{rc}/open-sections{query}",
        "body": body,
    }
