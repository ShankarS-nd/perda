"""
build_log.py — log every successful Test_Automation_Parallel_v2 build (older builds from
Test_Automation_Parallel stay in the log; that job no longer produces builds).

For each SUCCESS build we pull only the small artifacts Jenkins already
publishes (overall_summary.txt, parameters.json) plus the two DAST report pages
(linked_issues.html / unknown_issue.html). The 100MB+ scr.js is never touched,
so a sync of a dozen builds takes seconds.

Percentages share one denominator — applicable tests, i.e. Pass + Fail + Not
Executed (Not Applicable is excluded, as in rc_comparison) — so
pass% + known% + unknown% + not-executed% = 100.
"""

from __future__ import annotations

import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable

import requests
from bs4 import BeautifulSoup

from database import get_logged_builds_needing_retry, get_logged_build_numbers, save_logged_build

logger = logging.getLogger("uvicorn.error")

JENKINS_JOB_URL = (
    "https://build-device.netradyne.info/view/Daily_Build_Pipeline"
    "/job/Test_Automation_Parallel_v2"
)
REQUEST_TIMEOUT = 30
DEFAULT_LOOKBACK = 30
FETCH_WORKERS = 4  # builds fetched in parallel — enough to be quick, gentle on Jenkins

_sync_lock = threading.Lock()

# Progress of the sync in flight, for the UI. Guarded by _progress_lock.
_progress_lock = threading.Lock()
_progress: dict[str, Any] = {"running": False, "done": 0, "todo": 0, "full": False}


def get_sync_status() -> dict[str, Any]:
    with _progress_lock:
        return dict(_progress)


def _set_progress(**kw: Any) -> None:
    with _progress_lock:
        _progress.update(kw)


class JenkinsAuthError(RuntimeError):
    """Jenkins bounced us to a login page — the API token is stale."""


def _get(session: requests.Session, url: str, **kw) -> requests.Response:
    """GET that turns Jenkins' login redirect into JenkinsAuthError.

    Artifacts answer with a 302 to a presigned S3 URL, so redirects are followed
    by hand: only a redirect to the login flow is an auth failure.
    """
    resp = session.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=False, **kw)
    hops = 0
    while resp.status_code in (301, 302, 303, 307, 308) and hops < 3:
        loc = resp.headers.get("Location", "")
        if "commenceLogin" in loc or "securityRealm" in loc:
            raise JenkinsAuthError(f"Jenkins authentication failed fetching {url}")
        # Presigned S3 URL: it carries its own auth, and S3 rejects (400) a
        # request that also sends Jenkins' Basic credentials — so go bare.
        resp = requests.get(loc, timeout=REQUEST_TIMEOUT, allow_redirects=False)
        hops += 1
    if resp.status_code in (401, 403):
        raise JenkinsAuthError(f"Jenkins authentication failed ({resp.status_code}) fetching {url}")
    return resp


def _pct(part: int, whole: int) -> float:
    return round(part / whole * 100, 2) if whole > 0 else 0.0


def parse_overall_summary(html: str) -> list[dict[str, Any]]:
    """One dict per device from overall_summary.txt's HTML table."""
    soup = BeautifulSoup(html, "lxml")
    devices = []
    for tr in soup.select("tbody tr"):
        c = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(c) < 11:
            continue
        total, p, f, ne, na = (int(x) if x.isdigit() else 0 for x in c[6:11])
        devices.append({
            "device_id": c[0], "sku": c[1], "os_version": c[2], "package": c[3],
            "ip": c[4], "started_at": c[5],
            "total": total, "pass": p, "fail": f, "not_executed": ne, "not_applicable": na,
            "pass_pct": _pct(p, p + f + ne),
        })
    return devices


def parse_dast_count(html: str, label: str) -> int | None:
    """The 'Total Failed Test Cases …' figure in a DAST page header table."""
    for th in BeautifulSoup(html, "lxml").find_all("th"):
        if th.get_text(strip=True) == label:
            nxt = th.find_next_sibling("th")
            txt = nxt.get_text(strip=True) if nxt else ""
            return int(txt) if txt.isdigit() else None
    return None


def fetch_build_record(
    session: requests.Session, number: int, build: dict[str, Any],
) -> dict[str, Any] | None:
    """Assemble the log row for one build, or None if it has no report."""
    base = f"{JENKINS_JOB_URL}/{number}"

    resp = _get(session, f"{base}/artifact/overall_summary.txt")
    if resp.status_code != 200 or "<table" not in resp.text:
        logger.info(f"build-log: #{number} has no overall_summary.txt (HTTP {resp.status_code}), skipping")
        return None
    devices = parse_overall_summary(resp.text)
    if not devices:
        return None

    # Which services each device ran — useful context beside the package.
    resp = _get(session, f"{base}/artifact/parameters.json")
    if resp.status_code == 200:
        try:
            services = resp.json().get("segmented_services", {})
            for d in devices:
                d["services"] = services.get(d["device_id"], [])
        except ValueError:
            pass

    counts: dict[str, int | None] = {}
    for key, page, label in (
        ("known", "linked_issues.html", "Total Failed Test Cases with Linked Issues"),
        ("unknown", "unknown_issue.html", "Total Failed Test Cases"),
    ):
        r = _get(session, f"{base}/Test_5freport/{page}")
        counts[key] = parse_dast_count(r.text, label) if r.status_code == 200 else None

    tot = {k: sum(d[k] for d in devices) for k in ("pass", "fail", "not_executed", "not_applicable")}
    applicable = tot["pass"] + tot["fail"] + tot["not_executed"]
    known, unknown = counts["known"], counts["unknown"]
    if known is not None and unknown is not None and known + unknown != tot["fail"]:
        logger.warning(
            f"build-log: #{number} known({known}) + unknown({unknown}) != failures({tot['fail']})"
        )

    params = {}
    for action in build.get("actions", []):
        for p in action.get("parameters", []) or []:
            params[p.get("name")] = p.get("value")

    packages = sorted({d["package"] for d in devices if d["package"]})
    ts = build.get("timestamp")
    return {
        "build_number": number,
        "built_at": datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat() if ts else "",
        "duration_sec": int((build.get("duration") or 0) / 1000),
        "suite": params.get("Test_Suite") or "",
        "product": params.get("ProductCategory") or "",
        "packages": packages,
        "devices": devices,
        "pass_count": tot["pass"], "fail_count": tot["fail"],
        "ne_count": tot["not_executed"], "na_count": tot["not_applicable"],
        "known_count": known, "unknown_count": unknown,
        "pass_pct": _pct(tot["pass"], applicable),
        "known_pct": _pct(known, applicable) if known is not None else None,
        "unknown_pct": _pct(unknown, applicable) if unknown is not None else None,
        "build_url": f"{base}/",
        "report_url": f"{base}/Test_5freport/",
    }


def sync_builds(
    session_factory: Callable[[], requests.Session],
    refresh_auth: Callable[[], bool] | None = None,
    lookback: int | None = DEFAULT_LOOKBACK,
) -> dict[str, Any]:
    """Log any SUCCESS build among the newest `lookback` that isn't logged yet.

    lookback=None means every build Jenkins still has. Blocking — call from a
    worker thread. Rows logged earlier without known / unknown counts (DAST
    pages not ready yet) are re-fetched too. Returns a summary; raises
    JenkinsAuthError if the token is bad even after refresh_auth.
    """
    if not _sync_lock.acquire(blocking=False):
        return {"ok": True, "busy": True, "added": [], "updated": [], "skipped": []}
    _set_progress(running=True, done=0, todo=0, full=lookback is None)
    try:
        try:
            return _sync(session_factory, lookback)
        except JenkinsAuthError:
            if not refresh_auth or not refresh_auth():
                raise
            return _sync(session_factory, lookback)
    finally:
        _set_progress(running=False)
        _sync_lock.release()


def _sync(session_factory: Callable[[], requests.Session], lookback: int | None) -> dict[str, Any]:
    session = session_factory()
    if lookback is None:
        tree = "allBuilds[number,result,building]"
    else:
        tree = f"builds[number,result,building]{{0,{int(lookback)}}}"
    resp = _get(session, f"{JENKINS_JOB_URL}/api/json", params={"tree": tree})
    resp.raise_for_status()
    data = resp.json()
    builds = data.get("allBuilds") if lookback is None else data.get("builds")
    successful = sorted(b["number"] for b in builds or [] if b.get("result") == "SUCCESS")
    have = get_logged_build_numbers()
    retry = set(get_logged_builds_needing_retry())
    # Newest first, so the page fills from the top while a long backfill runs.
    todo = sorted((n for n in successful if n not in have or n in retry), reverse=True)
    _set_progress(todo=len(todo), done=0)

    added: list[int] = []
    updated: list[int] = []
    skipped: list[int] = []
    errors: list[int] = []
    auth_error: list[JenkinsAuthError] = []

    def one(n: int) -> None:
        if auth_error:
            return
        sess = session_factory()  # a session per worker; they aren't guaranteed thread-safe
        try:
            detail = _get(
                sess, f"{JENKINS_JOB_URL}/{n}/api/json",
                params={"tree": "timestamp,duration,actions[parameters[name,value]]"},
            )
            detail.raise_for_status()
            record = fetch_build_record(sess, n, detail.json())
            if record is None:
                skipped.append(n)
                return
            save_logged_build(record)
            (updated if n in have else added).append(n)
            logger.info(f"build-log: logged #{n} (pass {record['pass_pct']}%)")
        except JenkinsAuthError as exc:
            auth_error.append(exc)
        except Exception as exc:  # one bad build must not sink the rest
            logger.warning(f"build-log: #{n} failed: {exc}")
            errors.append(n)
        finally:
            with _progress_lock:
                _progress["done"] += 1

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        list(pool.map(one, todo))
    if auth_error:
        raise auth_error[0]
    return {
        "ok": True, "busy": False,
        "added": sorted(added), "updated": sorted(updated),
        "skipped": sorted(skipped), "errors": sorted(errors),
    }
