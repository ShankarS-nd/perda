"""
build_log.py — log every successful build of the two test-report jobs:

  daily  Test_Automation_Parallel_v2 (Daily_Build_Pipeline). Older builds from
         Test_Automation_Parallel stay in the log; that job no longer produces builds.
  octo   Octo_Test_Automation_Report (Acceptance_Testing_Pipeline).

For each SUCCESS build we pull only small files plus the two DAST report pages
(linked_issues.html / unknown_issue.html):
  daily  overall_summary.txt + parameters.json artifacts; scr.js is never touched.
  octo   publishes neither file, so the per-device table is read from the `row`
         block of the report's static/scr.js. That block sits a few MB into an
         80MB+ file, so the download is streamed and dropped as soon as it is read.

Percentages share one denominator — applicable tests, i.e. Pass + Fail + Not
Executed (Not Applicable is excluded, as in rc_comparison) — so
pass% + known% + unknown% + not-executed% = 100.

Only one sync runs at a time across all backend worker processes (file lock);
its progress is shared through a small JSON file next to the lock.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from itertools import zip_longest
from pathlib import Path
from typing import Any, Callable

import requests
from bs4 import BeautifulSoup

from database import get_logged_builds_needing_retry, get_logged_build_numbers, save_logged_build

logger = logging.getLogger("uvicorn.error")

JENKINS_JOB_URL = (
    "https://build-device.netradyne.info/view/Daily_Build_Pipeline"
    "/job/Test_Automation_Parallel_v2"
)
OCTO_JOB_URL = (
    "https://build-device.netradyne.info/view/Acceptance_Testing_Pipeline"
    "/job/Octo_Test_Automation_Report"
)
# job key → Jenkins job URL. Keys are stored in build_log.job.
JOBS: dict[str, str] = {"daily": JENKINS_JOB_URL, "octo": OCTO_JOB_URL}
JOB_LABELS = {"daily": "", "octo": "Octo "}  # prefix for build numbers in messages

REQUEST_TIMEOUT = 30
DEFAULT_LOOKBACK = 30
FETCH_WORKERS = 4  # builds fetched in parallel — enough to be quick, gentle on Jenkins
# Give up on scr.js if the `row` block hasn't shown up after this many bytes.
SCRJS_READ_LIMIT = 60 * 1024 * 1024

_STATE_DIR = Path(os.getenv("PERDA_BUILD_LOG_STATE_DIR", Path(__file__).resolve().parent / "output"))
_LOCK_FILE = _STATE_DIR / "build_log_sync.lock"
_PROGRESS_FILE = _STATE_DIR / "build_log_sync.json"

_sync_lock = threading.Lock()

# Progress of the sync in flight, for the UI. Guarded by _progress_lock and
# mirrored to _PROGRESS_FILE so every worker process can report it.
_progress_lock = threading.Lock()
_progress: dict[str, Any] = {"running": False, "done": 0, "todo": 0, "full": False}


def _try_file_lock():
    """The cross-process sync lock, or None if another process holds it."""
    _STATE_DIR.mkdir(parents=True, exist_ok=True)
    fh = open(_LOCK_FILE, "a+")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fh
    except BlockingIOError:
        fh.close()
        return None


def _release_file_lock(fh) -> None:
    fcntl.flock(fh, fcntl.LOCK_UN)
    fh.close()


def get_sync_status() -> dict[str, Any]:
    if _sync_lock.locked():  # this process is syncing
        with _progress_lock:
            return dict(_progress)
    try:
        st = json.loads(_PROGRESS_FILE.read_text())
    except (OSError, ValueError):
        st = {"done": 0, "todo": 0, "full": False}
    # Running only if some process holds the lock — a crashed sync leaves a
    # stale file but no lock.
    fh = _try_file_lock()
    if fh is not None:
        _release_file_lock(fh)
    st["running"] = fh is None
    return st


def _set_progress(**kw: Any) -> None:
    with _progress_lock:
        _progress.update(kw)
        _write_progress()


def _write_progress() -> None:
    """Call with _progress_lock held."""
    try:
        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _PROGRESS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_progress))
        tmp.replace(_PROGRESS_FILE)
    except OSError:
        pass


class JenkinsAuthError(RuntimeError):
    """Jenkins bounced us to a login page — the API token is stale."""


def _get(session: requests.Session, url: str, stream: bool = False, **kw) -> requests.Response:
    """GET that turns Jenkins' login redirect into JenkinsAuthError.

    Artifacts answer with a 302 to a presigned S3 URL, so redirects are followed
    by hand: only a redirect to the login flow is an auth failure.
    """
    resp = session.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=False, stream=stream, **kw)
    hops = 0
    while resp.status_code in (301, 302, 303, 307, 308) and hops < 3:
        loc = resp.headers.get("Location", "")
        resp.close()
        if "commenceLogin" in loc or "securityRealm" in loc:
            raise JenkinsAuthError(f"Jenkins authentication failed fetching {url}")
        # Presigned S3 URL: it carries its own auth, and S3 rejects (400) a
        # request that also sends Jenkins' Basic credentials — so go bare.
        resp = requests.get(loc, timeout=REQUEST_TIMEOUT, allow_redirects=False, stream=stream)
        hops += 1
    if resp.status_code in (401, 403):
        resp.close()
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


def _num(v: Any) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def read_scrjs_rows(chunks) -> list[dict[str, Any]] | None:
    """The `const row = [...]` block of a DAST scr.js, read from a stream of
    byte chunks; stops as soon as the block is complete. None if not found."""
    marker = b"const row = "
    buf = b""
    start = -1
    decoder = json.JSONDecoder()
    for chunk in chunks:
        buf += chunk
        if start < 0:
            start = buf.find(marker)
            if start < 0:
                buf = buf[-len(marker):]  # keep only what could be a split marker
                continue
            buf = buf[start + len(marker):]
        # The block is plain JSON (double-quoted keys). Try to decode once the
        # closing "];" has arrived.
        if b"];" not in buf:
            if len(buf) > 5 * 1024 * 1024:  # the block itself is a few KB
                return None
            continue
        try:
            rows, _ = decoder.raw_decode(buf.decode("utf-8", "replace"))
        except ValueError:
            continue
        return rows if isinstance(rows, list) else None
    return None


def parse_scrjs_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Devices in the same shape as parse_overall_summary, from scr.js `row`."""
    devices = []
    for r in rows:
        if not isinstance(r, dict) or not r.get("Serial_Number"):
            continue
        p, f, ne = _num(r.get("pass_count")), _num(r.get("fail_count")), _num(r.get("NE_count"))
        devices.append({
            "device_id": str(r["Serial_Number"]), "sku": r.get("Product_Type") or "",
            "os_version": r.get("OS_Version") or "", "package": r.get("OTA_Version") or "",
            "ip": r.get("Ip_Address") or "", "started_at": r.get("Start_Timestamp") or "",
            "total": _num(r.get("total_count")), "pass": p, "fail": f,
            "not_executed": ne, "not_applicable": _num(r.get("NA_count")),
            "pass_pct": _pct(p, p + f + ne),
        })
    return sorted(devices, key=lambda d: d["device_id"])


def octo_services(params: dict[str, Any]) -> dict[str, list[str]]:
    """Device → services from the Octo job's Setup_NN_Devices / Setup_NN_Services
    parameters (only setups whose Enable_Setup_NN is on)."""
    out: dict[str, list[str]] = {}
    for name, value in params.items():
        m = re.fullmatch(r"Setup_(\d+)_Devices", name or "")
        if not m or params.get(f"Enable_Setup_{m.group(1)}") is False:
            continue
        services = [x.strip() for x in str(params.get(f"Setup_{m.group(1)}_Services") or "").split(",") if x.strip()]
        for dev in re.split(r"[,\s]+", str(value or "")):
            if dev:
                out.setdefault(dev, []).extend(services)
    return out


def _daily_devices(session: requests.Session, base: str, number: int) -> list[dict[str, Any]] | None:
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
    return devices


def _octo_devices(
    session: requests.Session, base: str, number: int, params: dict[str, Any],
) -> list[dict[str, Any]] | None:
    resp = _get(session, f"{base}/Test_5freport/static/scr.js", stream=True)
    try:
        if resp.status_code != 200:
            logger.info(f"build-log: Octo #{number} has no scr.js (HTTP {resp.status_code}), skipping")
            return None
        read = 0

        def chunks():
            nonlocal read
            for c in resp.iter_content(1 << 20):
                read += len(c)
                if read > SCRJS_READ_LIMIT:
                    return
                yield c

        rows = read_scrjs_rows(chunks())
    finally:
        resp.close()
    devices = parse_scrjs_rows(rows or [])
    if not devices:
        logger.info(f"build-log: Octo #{number} scr.js has no device summary, skipping")
        return None
    services = octo_services(params)
    for d in devices:
        d["services"] = services.get(d["device_id"], [])
    return devices


def fetch_build_record(
    session: requests.Session, number: int, build: dict[str, Any], job: str = "daily",
) -> dict[str, Any] | None:
    """Assemble the log row for one build, or None if it has no report."""
    base = f"{JOBS[job]}/{number}"

    params: dict[str, Any] = {}
    for action in build.get("actions", []):
        for p in action.get("parameters", []) or []:
            params[p.get("name")] = p.get("value")

    if job == "octo":
        devices = _octo_devices(session, base, number, params)
    else:
        devices = _daily_devices(session, base, number)
    if not devices:
        return None

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
            f"build-log: {job} #{number} known({known}) + unknown({unknown}) != failures({tot['fail']})"
        )

    packages = sorted({d["package"] for d in devices if d["package"]})
    ts = build.get("timestamp")
    return {
        "job": job,
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
    """Log any SUCCESS build among the newest `lookback` of each job that isn't logged yet.

    lookback=None means every build Jenkins still has. Blocking — call from a
    worker thread. Rows logged earlier without known / unknown counts (DAST
    pages not ready yet) are re-fetched too. Returns a summary whose build lists
    are labels ("#5120", "Octo #476"); raises JenkinsAuthError if the token is
    bad even after refresh_auth.
    """
    busy = {"ok": True, "busy": True, "added": [], "updated": [], "skipped": [], "errors": []}
    if not _sync_lock.acquire(blocking=False):
        return busy
    fh = _try_file_lock()
    if fh is None:  # another worker process is syncing
        _sync_lock.release()
        return busy
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
        _release_file_lock(fh)
        _sync_lock.release()


def _sync(session_factory: Callable[[], requests.Session], lookback: int | None) -> dict[str, Any]:
    session = session_factory()
    if lookback is None:
        tree = "allBuilds[number,result,building]"
    else:
        tree = f"builds[number,result,building]{{0,{int(lookback)}}}"

    per_job: list[list[tuple[str, int]]] = []
    have: dict[str, set[int]] = {}
    for job, url in JOBS.items():
        resp = _get(session, f"{url}/api/json", params={"tree": tree})
        resp.raise_for_status()
        data = resp.json()
        builds = data.get("allBuilds") if lookback is None else data.get("builds")
        successful = {b["number"] for b in builds or [] if b.get("result") == "SUCCESS"}
        have[job] = get_logged_build_numbers(job)
        retry = set(get_logged_builds_needing_retry(job))
        per_job.append([(job, n) for n in sorted(successful, reverse=True)
                        if n not in have[job] or n in retry])
    # Newest first within each job, jobs taken in turn, so both fill from the
    # top while a long backfill runs.
    todo = [t for group in zip_longest(*per_job) for t in group if t]
    _set_progress(todo=len(todo), done=0)

    added: list[str] = []
    updated: list[str] = []
    skipped: list[str] = []
    errors: list[str] = []
    auth_error: list[JenkinsAuthError] = []

    def one(item: tuple[str, int]) -> None:
        job, n = item
        label = f"{JOB_LABELS[job]}#{n}"
        if auth_error:
            return
        sess = session_factory()  # a session per worker; they aren't guaranteed thread-safe
        try:
            detail = _get(
                sess, f"{JOBS[job]}/{n}/api/json",
                params={"tree": "timestamp,duration,actions[parameters[name,value]]"},
            )
            detail.raise_for_status()
            record = fetch_build_record(sess, n, detail.json(), job)
            if record is None:
                skipped.append(label)
                return
            save_logged_build(record)
            (updated if n in have[job] else added).append(label)
            logger.info(f"build-log: logged {job} #{n} (pass {record['pass_pct']}%)")
        except JenkinsAuthError as exc:
            auth_error.append(exc)
        except Exception as exc:  # one bad build must not sink the rest
            logger.warning(f"build-log: {job} #{n} failed: {exc}")
            errors.append(label)
        finally:
            with _progress_lock:
                _progress["done"] += 1
                _write_progress()

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        list(pool.map(one, todo))
    if auth_error:
        raise auth_error[0]
    return {
        "ok": True, "busy": False,
        "added": added, "updated": updated, "skipped": skipped, "errors": errors,
    }

