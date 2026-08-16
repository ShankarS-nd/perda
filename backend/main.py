"""
Perda Backend — FastAPI entry point.

Provides REST endpoints for the Script Runner Dashboard:
  GET  /scripts               → list available scripts and their arguments
  POST /run-script            → execute a script with the supplied arguments
  POST /run-script-stream     → execute via SSE (Server-Sent Events)
  GET  /outputs/{script_name} → list output files produced by a script
  GET  /download              → download a specific output file

Workflow endpoints:
  POST /workflows             → create or update a workflow
  GET  /workflows             → list all workflows
  GET  /workflows/{id}        → single workflow
  DELETE /workflows/{id}      → delete workflow
  POST /workflows/run         → execute a workflow (SSE)
  GET  /workflows/runs        → execution history
  GET  /workflows/runs/{id}   → single run detail

Test Report Summary endpoint:
  POST /test-report-summary   → return dashboard data for two builds

Device Logs endpoints:
  POST /device-logs/download  → run logs_download.py via SSE stream
  GET  /device-logs/files     → list processed log service files for device+date
  POST /device-logs/read      → read & filter logs by epoch time range
"""

import json
from pathlib import Path
from typing import Any
import logging
import os
import requests as _requests_lib

logger = logging.getLogger("uvicorn.error")

from dotenv import load_dotenv
load_dotenv()  # Load .env file (JENKINS_USER, JENKINS_TOKEN, etc.)


# ---------------------------------------------------------------------------
# Jenkins token auto-refresh helper
# ---------------------------------------------------------------------------
_JENKINS_URL = "https://build-device.netradyne.info"
_JENKINS_SECURITY_PATH = "/user/s.shankar@netradyne.com/security/"

import time as _time
_jenkins_auth_failure_ts: float = 0.0  # timestamp of last known auth failure
_JENKINS_AUTH_COOLDOWN = 300  # 5 minutes — don't retry Jenkins auth within this window


def _jenkins_auth_is_broken() -> bool:
    """Return True if Jenkins auth failed recently (within cooldown window)."""
    global _jenkins_auth_failure_ts
    return (_time.time() - _jenkins_auth_failure_ts) < _JENKINS_AUTH_COOLDOWN


def _mark_jenkins_auth_failed():
    """Record that Jenkins auth just failed."""
    global _jenkins_auth_failure_ts
    _jenkins_auth_failure_ts = _time.time()


def _refresh_jenkins_token() -> dict:
    """
    Hit the Jenkins security page with Basic Auth to keep the API token alive.
    Returns {"ok": True/False, "http_code": int, "message": str}.
    """
    user = os.getenv("JENKINS_USER", "")
    token = os.getenv("JENKINS_TOKEN", "")
    if not user or not token:
        return {"ok": False, "http_code": 0, "message": "JENKINS_USER or JENKINS_TOKEN not set in .env"}
    try:
        resp = _requests_lib.get(
            f"{_JENKINS_URL}{_JENKINS_SECURITY_PATH}",
            auth=(user, token),
            timeout=10,
            verify=False,
        )
        code = resp.status_code
        if code == 200:
            logger.info("Jenkins token refreshed successfully (HTTP 200)")
            return {"ok": True, "http_code": code, "message": "Token refreshed successfully"}
        else:
            logger.warning(f"Jenkins token refresh returned HTTP {code}")
            return {"ok": False, "http_code": code, "message": f"Security page returned HTTP {code}"}
    except Exception as exc:
        logger.error(f"Jenkins token refresh failed: {exc}")
        return {"ok": False, "http_code": 0, "message": str(exc)}


def _is_jenkins_auth_error(text: str) -> bool:
    """Check if an error message indicates a Jenkins authentication failure."""
    lower = text.lower()
    return any(kw in lower for kw in [
        "authentication failed",
        "jenkins authentication",
        "commencelogin",
        "securityrealm",
        "token may have expired",
        "jenkins_token has likely expired",
        "redirect to login",
    ])


from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel

from script_runner import (
    list_scripts,
    run_script,
    stream_script,
    get_output_files,
    RunScriptRequest,
)
from database import (
    init_db,
    get_recent_runs,
    get_run_by_id,
    save_workflow,
    get_workflows,
    get_workflow_by_id,
    delete_workflow,
    get_workflow_runs,
    get_workflow_run_detail,
)
from workflow_engine import run_workflow

app = FastAPI(
    title="Perda — Developer Automation Platform",
    version="0.1.0",
)

# ---------------------------------------------------------------------------
# Database — ensure table exists on startup
# ---------------------------------------------------------------------------
init_db()

# ---------------------------------------------------------------------------
# CORS — allow the Next.js dev server to reach the API
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Preset builds — fixed previous-build job numbers for the Quick Select UI
# ---------------------------------------------------------------------------
SCRJS_CACHE_DIR = Path(__file__).parent / "cache" / "scrjs"

PRESET_BUILDS: dict[str, str] = {
    "857": "5.6.13.rc.2 --> B3 US",
    "865": "5.6.13.rc.2 --> K1 US",
    "871": "5.6.13.rc.2 --> B2 US",
    "864": "5.6.13.rc.2 --> K2 US",
    "870": "5.6.13.rc.2 --> K2 IN",
    "873": "5.6.13.rc.2 --> K1 UK",
    "872": "5.6.13.rc.2 --> B3 IN",
}

PLATFORM_BUILDS_FILE = Path(__file__).parent / "platform_builds.json"


def _load_platform_builds() -> dict[str, list[str]]:
    """Load platform→builds mapping from JSON file."""
    if PLATFORM_BUILDS_FILE.exists():
        return json.loads(PLATFORM_BUILDS_FILE.read_text())
    return {}


def _save_platform_builds(data: dict[str, list[str]]) -> None:
    """Persist platform→builds mapping to JSON file."""
    PLATFORM_BUILDS_FILE.write_text(json.dumps(data, indent=2) + "\n")


# ---------------------------------------------------------------------------
# Platform Builds — persistent storage of latest builds per platform
# ---------------------------------------------------------------------------

@app.get("/platform-builds")
async def get_platform_builds():
    """Return the stored platform→builds mapping."""
    return _load_platform_builds()


class PlatformBuildsUpdate(BaseModel):
    builds: dict[str, list[str]]   # e.g. {"K1_UK": ["1169","1166",...], ...}


@app.put("/platform-builds")
async def update_platform_builds(payload: PlatformBuildsUpdate):
    """Replace the entire platform→builds mapping."""
    _save_platform_builds(payload.builds)
    return {"status": "ok", "platforms": list(payload.builds.keys())}


class SinglePlatformUpdate(BaseModel):
    platform: str
    builds: list[str]


@app.patch("/platform-builds")
async def patch_platform_builds(payload: SinglePlatformUpdate):
    """Update builds for a single platform."""
    data = _load_platform_builds()
    data[payload.platform.strip().upper()] = payload.builds
    _save_platform_builds(data)
    return {"status": "ok", "platform": payload.platform.strip().upper(), "builds": payload.builds}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/scripts")
async def get_scripts():
    """Return every discoverable script together with its expected arguments."""
    return list_scripts()


# ---------------------------------------------------------------------------
# Preset build cache
# ---------------------------------------------------------------------------

@app.get("/preset-cache-status")
async def preset_cache_status():
    """Return cache hit/miss status for each preset build."""
    result = {}
    for build_num, label in PRESET_BUILDS.items():
        cache_file = SCRJS_CACHE_DIR / f"{build_num}.js"
        cached = cache_file.is_file()
        result[build_num] = {
            "label": label,
            "cached": cached,
            "size": cache_file.stat().st_size if cached else 0,
        }
    return result


@app.post("/seed-preset-cache")
async def seed_preset_cache():
    """Download and cache scr.js for all preset builds (SSE progress stream)."""
    from scripts.rc_comparison import _jenkins_session, fetch_report_js

    def stream():
        session = _jenkins_session()
        for build_num, label in PRESET_BUILDS.items():
            cache_file = SCRJS_CACHE_DIR / f"{build_num}.js"
            if cache_file.is_file():
                payload = json.dumps({
                    "build": build_num, "label": label,
                    "status": "cached",
                    "msg": f"Already cached ({cache_file.stat().st_size:,} bytes)",
                })
                yield f"data: {payload}\n\n"
                continue

            payload = json.dumps({
                "build": build_num, "label": label,
                "status": "downloading", "msg": "Downloading from Jenkins…",
            })
            yield f"data: {payload}\n\n"

            try:
                js = fetch_report_js(build_num, session, use_cache=True)
                payload = json.dumps({
                    "build": build_num, "label": label,
                    "status": "ok",
                    "msg": f"Cached ({len(js):,} bytes)",
                })
            except (SystemExit, Exception) as exc:
                if _is_jenkins_auth_error(str(exc)):
                    logger.info(f"Jenkins auth failure for preset build {build_num} — refreshing token…")
                    refresh = _refresh_jenkins_token()
                    if refresh["ok"]:
                        session = _jenkins_session()
                        try:
                            js = fetch_report_js(build_num, session, use_cache=True)
                            payload = json.dumps({
                                "build": build_num, "label": label,
                                "status": "ok",
                                "msg": f"Cached after token refresh ({len(js):,} bytes)",
                            })
                        except (SystemExit, Exception) as exc2:
                            payload = json.dumps({
                                "build": build_num, "label": label,
                                "status": "error", "msg": str(exc2),
                            })
                    else:
                        payload = json.dumps({
                            "build": build_num, "label": label,
                            "status": "error", "msg": str(exc),
                        })
                else:
                    payload = json.dumps({
                        "build": build_num, "label": label,
                        "status": "error", "msg": str(exc),
                    })
            yield f"data: {payload}\n\n"

        yield f"data: {json.dumps({'status': 'done'})}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Jenkins token refresh endpoint
# ---------------------------------------------------------------------------

@app.post("/jenkins-token-refresh")
async def jenkins_token_refresh():
    """Manually trigger a Jenkins token refresh by hitting the security page."""
    result = _refresh_jenkins_token()
    return result


@app.post("/run-script")
async def execute_script(payload: RunScriptRequest):
    """Run the requested script and return stdout / stderr."""
    return run_script(payload)


@app.post("/run-script-stream")
async def execute_script_stream(payload: RunScriptRequest):
    """Run a script and stream output line-by-line via Server-Sent Events."""
    return StreamingResponse(
        stream_script(payload),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable nginx buffering if present
        },
    )


@app.get("/outputs/{script_name}")
async def get_outputs(script_name: str):
    """Return the list of output files produced by a script."""
    return get_output_files(script_name)


@app.get("/download")
async def download_file(path: str = Query(..., description="Absolute path to the file")):
    """Download a specific output file."""
    file_path = Path(path)
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    # Security: only allow files under known output directories
    return FileResponse(
        path=str(file_path),
        filename=file_path.name,
        media_type="application/octet-stream",
    )


# ---------------------------------------------------------------------------
# Run History
# ---------------------------------------------------------------------------

@app.get("/runs")
async def get_runs(limit: int = Query(50, ge=1, le=500)):
    """Return the most recent script executions."""
    return get_recent_runs(limit)


@app.get("/runs/{run_id}")
async def get_run(run_id: int):
    """Return a single run by id (includes full stdout/stderr)."""
    row = get_run_by_id(run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return row


# ---------------------------------------------------------------------------
# Workflow CRUD
# ---------------------------------------------------------------------------

class WorkflowPayload(BaseModel):
    id: int | None = None
    name: str
    description: str = ""
    definition: dict[str, Any] = {}


class WorkflowRunRequest(BaseModel):
    workflow_id: int


@app.post("/workflows")
async def create_or_update_workflow(payload: WorkflowPayload):
    """Create or update a workflow definition."""
    wid = save_workflow(
        name=payload.name,
        description=payload.description,
        definition_json=payload.definition,
        workflow_id=payload.id,
    )
    return {"id": wid}


@app.get("/workflows")
async def list_all_workflows():
    """Return all saved workflows."""
    return get_workflows()


# Workflow runs routes MUST be before /workflows/{workflow_id} to avoid
# FastAPI matching "runs" as a workflow_id path parameter.

@app.get("/workflows/runs")
async def list_workflow_runs(
    workflow_id: int | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    return get_workflow_runs(workflow_id, limit)


@app.get("/workflows/runs/{run_id}")
async def get_single_workflow_run(run_id: int):
    detail = get_workflow_run_detail(run_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    return detail


@app.get("/workflows/{workflow_id}")
async def get_single_workflow(workflow_id: int):
    row = get_workflow_by_id(workflow_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return row


@app.delete("/workflows/{workflow_id}")
async def remove_workflow(workflow_id: int):
    ok = delete_workflow(workflow_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Workflow Execution
# ---------------------------------------------------------------------------

@app.post("/workflows/run")
async def execute_workflow(payload: WorkflowRunRequest):
    """Execute a workflow via SSE streaming."""
    wf = get_workflow_by_id(payload.workflow_id)
    if wf is None:
        raise HTTPException(status_code=404, detail="Workflow not found")

    definition = json.loads(wf["definition_json"]) if isinstance(wf["definition_json"], str) else wf["definition_json"]

    return StreamingResponse(
        run_workflow(payload.workflow_id, definition),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Test Report Summary — dashboard data
# ---------------------------------------------------------------------------

class TestReportRequest(BaseModel):
    rc1: str = ""
    rc2: str = ""
    rc1_url: str = ""
    rc2_url: str = ""
    platform: str = "K1_US"
    force_refresh: bool = False


@app.post("/test-report-summary")
async def test_report_summary(payload: TestReportRequest):
    """Return structured dashboard data comparing two Jenkins builds.

    Accepts either build numbers (rc1/rc2) or direct Jenkins URLs (rc1_url/rc2_url).
    URLs take priority over build numbers when both are provided.
    Reuses parsing logic from scripts/rc_comparison.py.
    """
    # Import at call-time to avoid circular / heavy init on startup
    from scripts.rc_comparison import (
        DEVICE_SERIALS,
        PLATFORMS,
        SERIAL_LOOKUP,
        _jenkins_session,
        fetch_report_js,
        fetch_report_js_from_url,
        fetch_dast_known_unknown_counts,
        fetch_dast_counts_from_url,
        parse_jenkins_url,
        _url_cache_key,
        parse_report_data,
        aggregate_results,
        extract_tc_id,
        is_linked,
    )
    import pandas as pd

    platform = payload.platform.strip().upper()
    if platform not in DEVICE_SERIALS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown platform '{platform}'. Valid: {', '.join(PLATFORMS)}",
        )

    # Determine whether we're using URLs or build numbers for each slot
    use_url_rc1 = bool(payload.rc1_url.strip())
    use_url_rc2 = bool(payload.rc2_url.strip())
    has_rc1 = use_url_rc1 or bool(payload.rc1.strip())
    has_rc2 = use_url_rc2 or bool(payload.rc2.strip())

    if not has_rc1 or not has_rc2:
        raise HTTPException(
            status_code=400,
            detail="Both builds are required. Provide build numbers (rc1/rc2) or direct URLs (rc1_url/rc2_url).",
        )

    # Fast-fail if Jenkins auth is known to be broken
    if _jenkins_auth_is_broken():
        raise HTTPException(
            status_code=503,
            detail="Jenkins authentication is currently unavailable (token expired). Please update JENKINS_TOKEN in .env on the server and restart the backend."
        )

    session = _jenkins_session()
    use_cache_rc2 = not payload.force_refresh

    # Track job base URLs for DAST count fetching
    rc2_job_base: str | None = None
    # Labels used for display and cache keys
    rc1_label = payload.rc1.strip()
    rc2_label = payload.rc2.strip()

    try:
        # ── Fetch rc1 ──
        if use_url_rc1:
            rc1_js, rc1_job_base, rc1_build = fetch_report_js_from_url(
                payload.rc1_url.strip(), session, use_cache=True,
            )
            rc1_label = rc1_label or rc1_build
        else:
            rc1_js = fetch_report_js(rc1_label, session, use_cache=True)

        # ── Fetch rc2 ──
        if use_url_rc2:
            rc2_js, rc2_job_base, rc2_build = fetch_report_js_from_url(
                payload.rc2_url.strip(), session, use_cache=use_cache_rc2,
            )
            rc2_label = rc2_label or rc2_build
        else:
            rc2_js = fetch_report_js(rc2_label, session, use_cache=use_cache_rc2)
    except (SystemExit, Exception) as exc:
        if _is_jenkins_auth_error(str(exc)):
            logger.info("Jenkins auth failure in test-report-summary — refreshing token and retrying…")
            refresh = _refresh_jenkins_token()
            if refresh["ok"]:
                session = _jenkins_session()
                try:
                    if use_url_rc1:
                        rc1_js, _, rc1_build = fetch_report_js_from_url(
                            payload.rc1_url.strip(), session, use_cache=True,
                        )
                        rc1_label = rc1_label or rc1_build
                    else:
                        rc1_js = fetch_report_js(rc1_label, session, use_cache=True)
                    if use_url_rc2:
                        rc2_js, rc2_job_base, rc2_build = fetch_report_js_from_url(
                            payload.rc2_url.strip(), session, use_cache=use_cache_rc2,
                        )
                        rc2_label = rc2_label or rc2_build
                    else:
                        rc2_js = fetch_report_js(rc2_label, session, use_cache=use_cache_rc2)
                except (SystemExit, Exception) as exc2:
                    raise HTTPException(status_code=500, detail=str(exc2))
            else:
                raise HTTPException(status_code=500, detail=str(exc))
        else:
            raise HTTPException(status_code=500, detail=str(exc))

    svc1, tc1_raw = parse_report_data(rc1_js)
    svc2, tc2_raw = parse_report_data(rc2_js)

    tc1 = aggregate_results(tc1_raw)
    tc2 = aggregate_results(tc2_raw)

    for df in [tc1, tc2]:
        df["TC_ID"] = df["Testcase Name"].apply(extract_tc_id)

    # ── Extract OTA versions from scr.js content ──
    import re as _re_mod
    def _extract_ota(js_text: str) -> str:
        """Extract short OTA version like '2.6.14.rc.3' from scr.js."""
        m = _re_mod.search(r"\d+\.\d+\.\d+\.sp\.(\d+\.\d+\.\d+\.rc\.\d+)", js_text[:300000])
        return m.group(1) if m else ""

    rc1_ota = _extract_ota(rc1_js)
    rc2_ota = _extract_ota(rc2_js)

    # ── Previous build (rc1) overall stats ──
    rc1_total_pass = int(svc1["Pass"].sum())
    rc1_total_fail = int(svc1["Fail"].sum())
    rc1_total_ne = int(svc1["Not Executed"].sum())
    rc1_total_na = int(svc1["Not Applicable"].sum())
    rc1_total_all = rc1_total_pass + rc1_total_fail + rc1_total_ne + rc1_total_na

    tc1_fails = tc1[tc1["Result"] == "FAIL"].copy()
    rc1_known_count = int(tc1_fails["Linked Issues"].apply(is_linked).sum())
    rc1_unknown_count = len(tc1_fails) - rc1_known_count

    # ── Current build (rc2) overall stats ──
    total_pass = int(svc2["Pass"].sum())
    total_fail = int(svc2["Fail"].sum())
    total_ne = int(svc2["Not Executed"].sum())
    total_na = int(svc2["Not Applicable"].sum())
    total_all = total_pass + total_fail + total_ne + total_na

    # Classify failures as known/unknown in the current build
    tc2_fails = tc2[tc2["Result"] == "FAIL"].copy()
    tc2_known_count = int(tc2_fails["Linked Issues"].apply(is_linked).sum())
    tc2_unknown_count = len(tc2_fails) - tc2_known_count

    # Try to get authoritative counts from the DAST HTML report pages.
    # These are the ground-truth numbers shown on linked_issues.html and
    # unknown_issue.html.  When available they override our derived counts.
    # Cache results to a JSON file to avoid hitting Jenkins repeatedly.
    dast_cache_dir = Path(__file__).resolve().parent / "cache" / "dast_counts"
    # Use URL-aware cache key for DAST counts
    if use_url_rc2:
        dast_cache_key = _url_cache_key(rc2_job_base, rc2_label)
    else:
        dast_cache_key = rc2_label
    dast_cache_file = dast_cache_dir / f"{dast_cache_key}.json"
    dast_known: int | None = None
    dast_unknown: int | None = None

    if not payload.force_refresh and dast_cache_file.is_file():
        try:
            dast_cached = json.loads(dast_cache_file.read_text())
            dast_known = dast_cached.get("known")
            dast_unknown = dast_cached.get("unknown")
        except Exception:
            pass
    else:
        try:
            if use_url_rc2 and rc2_job_base:
                dast_known, dast_unknown = fetch_dast_counts_from_url(
                    rc2_job_base, rc2_label, session,
                )
            else:
                dast_known, dast_unknown = fetch_dast_known_unknown_counts(
                    rc2_label, session,
                )
        except (SystemExit, Exception):
            dast_known, dast_unknown = None, None
        # Persist to cache
        try:
            dast_cache_dir.mkdir(parents=True, exist_ok=True)
            dast_cache_file.write_text(json.dumps({"known": dast_known, "unknown": dast_unknown}))
        except Exception:
            pass
    if dast_known is not None:
        tc2_known_count = dast_known
    if dast_unknown is not None:
        tc2_unknown_count = dast_unknown
    elif dast_known is not None:
        # If we got known but not unknown, derive unknown from total
        tc2_unknown_count = len(tc2_fails) - tc2_known_count

    # ── Service-level drill-down for current build ──
    def _svc_tc_list(df: pd.DataFrame, condition=None) -> dict:
        """Group TCs by service. Returns {service: [{tc_id, name}, ...]}."""
        filtered = df if condition is None else df[condition].copy()
        result: dict[str, list] = {}
        for _, row in filtered.iterrows():
            svc = row.get("Service", "OTHER")
            tc_id = extract_tc_id(row["Testcase Name"])
            entry = {"tc_id": tc_id, "name": row["Testcase Name"]}
            if "Error Data" in row:
                entry["error"] = str(row["Error Data"]) if str(row["Error Data"]).upper() not in ("NA", "NAN") else ""
            if "Linked Issues" in row:
                entry["linked"] = str(row["Linked Issues"]) if is_linked(row["Linked Issues"]) else ""
            result.setdefault(svc, []).append(entry)
        # Sort TCs within each service
        for svc in result:
            result[svc].sort(key=lambda x: x["tc_id"])
        return dict(sorted(result.items()))

    # Previous build (rc1) breakdown by category
    rc1_pass_by_service = _svc_tc_list(tc1, tc1["Result"] == "PASS")
    rc1_known_fail_by_service = _svc_tc_list(
        tc1, (tc1["Result"] == "FAIL") & (tc1["Linked Issues"].apply(is_linked))
    )
    rc1_unknown_fail_by_service = _svc_tc_list(
        tc1, (tc1["Result"] == "FAIL") & (~tc1["Linked Issues"].apply(is_linked))
    )
    rc1_ne_by_service = _svc_tc_list(tc1, tc1["Result"] == "NE")

    # Current build breakdown by category
    pass_by_service = _svc_tc_list(tc2, tc2["Result"] == "PASS")
    known_fail_by_service = _svc_tc_list(
        tc2, (tc2["Result"] == "FAIL") & (tc2["Linked Issues"].apply(is_linked))
    )
    unknown_fail_by_service = _svc_tc_list(
        tc2, (tc2["Result"] == "FAIL") & (~tc2["Linked Issues"].apply(is_linked))
    )
    ne_by_service = _svc_tc_list(tc2, tc2["Result"] == "NE")

    # ── Regressions (RC1 vs RC2) ──
    rc1_df = tc1.rename(columns={
        "Result": "RC1_Result", "Error Data": "RC1_Error", "Linked Issues": "RC1_Linked",
    })
    rc2_df = tc2.rename(columns={
        "Result": "RC2_Result", "Error Data": "RC2_Error", "Linked Issues": "RC2_Linked",
    })
    merged = pd.merge(
        rc1_df[["Testcase Name", "TC_ID", "Service", "RC1_Result", "RC1_Error", "RC1_Linked"]],
        rc2_df[["Testcase Name", "TC_ID", "Service", "RC2_Result", "RC2_Error", "RC2_Linked"]],
        on=["Testcase Name", "TC_ID", "Service"], how="outer", indicator=True,
    )
    merged["RC1_Result"] = merged["RC1_Result"].fillna("NOT_PRESENT").str.upper().str.strip()
    merged["RC2_Result"] = merged["RC2_Result"].fillna("NOT_PRESENT").str.upper().str.strip()

    regressions = merged[
        (merged["RC1_Result"] == "PASS") & (merged["RC2_Result"] == "FAIL")
    ].copy()

    # ── New TCs (only in rc2, not in rc1) — common services only ──
    # ── Removed TCs (only in rc1, not in rc2) — common services only ──
    rc1_services = set(tc1["Service"].dropna().unique())
    rc2_services = set(tc2["Service"].dropna().unique())
    common_services = rc1_services & rc2_services

    new_tcs = merged[
        (merged["RC1_Result"] == "NOT_PRESENT") & (merged["Service"].isin(common_services))
    ].copy()
    removed_tcs = merged[
        (merged["RC2_Result"] == "NOT_PRESENT") & (merged["Service"].isin(common_services))
    ].copy()

    def _diff_tc_list(df: pd.DataFrame, result_col: str, error_col: str, linked_col: str) -> dict:
        """Group TCs by service for new/removed TC sections."""
        result_map: dict[str, list] = {}
        for _, row in df.iterrows():
            svc = row.get("Service", "OTHER")
            tc_id = row["TC_ID"]
            entry: dict = {
                "tc_id": tc_id,
                "name": row["Testcase Name"],
                "result": str(row.get(result_col, "")),
            }
            err_val = str(row.get(error_col, ""))
            entry["error"] = err_val if err_val.upper() not in ("NA", "NAN", "NAN", "") else ""
            lnk_val = row.get(linked_col, "")
            entry["linked"] = str(lnk_val) if is_linked(lnk_val) else ""
            result_map.setdefault(svc, []).append(entry)
        for svc in result_map:
            result_map[svc].sort(key=lambda x: x["tc_id"])
        return dict(sorted(result_map.items()))

    new_tcs_by_service = _diff_tc_list(new_tcs, "RC2_Result", "RC2_Error", "RC2_Linked")
    removed_tcs_by_service = _diff_tc_list(removed_tcs, "RC1_Result", "RC1_Error", "RC1_Linked")

    # ── Persistent failures (Fail → Fail) ──
    persistent = merged[
        (merged["RC1_Result"] == "FAIL") & (merged["RC2_Result"] == "FAIL")
    ].copy()
    persist_known = persistent[persistent["RC2_Linked"].apply(is_linked)].copy()
    persist_unknown = persistent[~persistent["RC2_Linked"].apply(is_linked)].copy()

    # ── Stable test cases (Pass → Pass) ──
    stable = merged[
        (merged["RC1_Result"] == "PASS") & (merged["RC2_Result"] == "PASS")
    ].copy()

    # ── Fixed test cases (Fail → Pass) ──
    fixed = merged[
        (merged["RC1_Result"] == "FAIL") & (merged["RC2_Result"] == "PASS")
    ].copy()

    reg_known = regressions[regressions["RC2_Linked"].apply(is_linked)].copy()
    reg_unknown = regressions[~regressions["RC2_Linked"].apply(is_linked)].copy()

    def _reg_tc_list(df: pd.DataFrame) -> dict:
        result: dict[str, list] = {}
        for _, row in df.iterrows():
            svc = row.get("Service", "OTHER")
            entry = {
                "tc_id": row["TC_ID"],
                "name": row["Testcase Name"],
                "error": str(row["RC2_Error"]) if str(row["RC2_Error"]).upper() not in ("NA", "NAN") else "",
                "linked": str(row["RC2_Linked"]) if is_linked(row["RC2_Linked"]) else "",
            }
            result.setdefault(svc, []).append(entry)
        for svc in result:
            result[svc].sort(key=lambda x: x["tc_id"])
        return dict(sorted(result.items()))

    def _stable_tc_list(df: pd.DataFrame) -> dict:
        """Group stable/fixed TCs by service (no error field needed for stable)."""
        result: dict[str, list] = {}
        for _, row in df.iterrows():
            svc = row.get("Service", "OTHER")
            entry = {
                "tc_id": row["TC_ID"],
                "name": row["Testcase Name"],
                "linked": str(row["RC2_Linked"]) if is_linked(row.get("RC2_Linked", "")) else "",
            }
            result.setdefault(svc, []).append(entry)
        for svc in result:
            result[svc].sort(key=lambda x: x["tc_id"])
        return dict(sorted(result.items()))

    def _fixed_tc_list(df: pd.DataFrame) -> dict:
        """Group fixed TCs by service (include the old error from RC1)."""
        result: dict[str, list] = {}
        for _, row in df.iterrows():
            svc = row.get("Service", "OTHER")
            old_err = str(row["RC1_Error"]) if str(row["RC1_Error"]).upper() not in ("NA", "NAN") else ""
            entry = {
                "tc_id": row["TC_ID"],
                "name": row["Testcase Name"],
                "old_error": old_err,
                "error": f"Previously: {old_err}" if old_err else "",
                "linked": str(row["RC1_Linked"]) if is_linked(row.get("RC1_Linked", "")) else "",
            }
            result.setdefault(svc, []).append(entry)
        for svc in result:
            result[svc].sort(key=lambda x: x["tc_id"])
        return dict(sorted(result.items()))

    # ── Service-level graph data (known/unknown fail counts) ──
    all_services = sorted(set(svc2["Service Name"].tolist()))
    known_graph = []
    unknown_graph = []
    for svc in all_services:
        svc_fails = tc2_fails[tc2_fails["Service"] == svc]
        k = int(svc_fails["Linked Issues"].apply(is_linked).sum())
        u = len(svc_fails) - k
        known_graph.append({"service": svc, "count": k})
        unknown_graph.append({"service": svc, "count": u})

    # ── Unique services (present in one build but not the other) ──
    only_in_rc1 = sorted(rc1_services - rc2_services)
    only_in_rc2 = sorted(rc2_services - rc1_services)

    def _svc_summary(df: pd.DataFrame, services: list) -> dict:
        """Build {service: {total, pass, fail, ne, tcs: [...]}} for given services."""
        result: dict[str, dict] = {}
        for svc in services:
            svc_tcs = df[df["Service"] == svc]
            total = len(svc_tcs)
            passed = int((svc_tcs["Result"] == "PASS").sum())
            failed = int((svc_tcs["Result"] == "FAIL").sum())
            ne = int((svc_tcs["Result"] == "NE").sum())
            tcs = []
            for _, row in svc_tcs.iterrows():
                tc_id = extract_tc_id(row["Testcase Name"])
                entry: dict = {"tc_id": tc_id, "name": row["Testcase Name"], "result": row["Result"]}
                if "Error Data" in row:
                    entry["error"] = str(row["Error Data"]) if str(row["Error Data"]).upper() not in ("NA", "NAN") else ""
                if "Linked Issues" in row:
                    entry["linked"] = str(row["Linked Issues"]) if is_linked(row["Linked Issues"]) else ""
                tcs.append(entry)
            tcs.sort(key=lambda x: x["tc_id"])
            result[svc] = {"total": total, "pass": passed, "fail": failed, "ne": ne, "tcs": tcs}
        return result

    unique_services = {
        "only_in_rc1": _svc_summary(tc1, only_in_rc1),
        "only_in_rc2": _svc_summary(tc2, only_in_rc2),
    }

    # ── Confidence data for regression TCs ──
    # Use stored platform builds to compute pass-rate for regression TCs
    platform_builds = _load_platform_builds()
    plat_key = platform  # e.g. "K1_US"
    confidence_builds = platform_builds.get(plat_key, [])
    reg_confidence: dict = {"builds": confidence_builds, "num_builds": len(confidence_builds), "known": {}, "unknown": {}}

    if confidence_builds and len(confidence_builds) >= 2:
        # Collect all regression TC IDs
        all_reg_tc_ids = set()
        for _, row in reg_known.iterrows():
            all_reg_tc_ids.add(row["TC_ID"])
        for _, row in reg_unknown.iterrows():
            all_reg_tc_ids.add(row["TC_ID"])

        if all_reg_tc_ids:
            # Only use builds that are already cached on disk — never hit Jenkins
            from scripts.rc_comparison import SCRJS_CACHE_DIR
            cached_conf_builds = [cb for cb in confidence_builds if (SCRJS_CACHE_DIR / f"{cb}.js").is_file()]

            conf_build_results: list[pd.DataFrame] = []
            for cb in cached_conf_builds:
                try:
                    cb_js = fetch_report_js(cb, session, use_cache=True)
                    _cb_svc, cb_tc_raw = parse_report_data(cb_js)
                    cb_tc = aggregate_results(cb_tc_raw)
                    cb_tc["TC_ID"] = cb_tc["Testcase Name"].apply(extract_tc_id)
                    cb_tc["_build"] = cb
                    conf_build_results.append(cb_tc)
                except (SystemExit, Exception):
                    pass  # skip builds that can't be parsed

            if conf_build_results:
                conf_all = pd.concat(conf_build_results, ignore_index=True)
                conf_all = conf_all[conf_all["TC_ID"].isin(all_reg_tc_ids)]
                n_conf_builds = len(conf_build_results)  # actual builds parsed
                reg_confidence["builds"] = cached_conf_builds
                reg_confidence["num_builds"] = n_conf_builds

                # Group by TC_ID only (not Service) to avoid service-name
                # mismatches between historical builds and the current build.
                conf_grouped = conf_all.groupby(["TC_ID"]).agg(
                    pass_count=("Result", lambda x: (x.str.upper() == "PASS").sum()),
                ).reset_index()
                conf_grouped["pass_pct"] = (conf_grouped["pass_count"] / n_conf_builds * 100).round(1)

                # Build a TC_ID → pass info lookup
                tc_conf_lookup: dict[str, dict] = {}
                for _, row in conf_grouped.iterrows():
                    tc_conf_lookup[row["TC_ID"]] = {
                        "pass_count": int(row["pass_count"]),
                        "total_builds": n_conf_builds,
                        "pass_pct": float(row["pass_pct"]),
                    }

                def _make_buckets(reg_df: pd.DataFrame) -> dict:
                    """Build confidence buckets using TCs from the regression df,
                    mapped to their services in the *current* build.
                    Timeout TCs are excluded from confidence analysis."""
                    buckets: dict[str, dict[str, list]] = {
                        "high": {}, "medium_high": {}, "medium": {},
                        "medium_low": {}, "low": {},
                    }
                    for _, row in reg_df.iterrows():
                        tc_id = row["TC_ID"]
                        # Skip timeout TCs
                        error_str = str(row.get("RC2_Error", ""))
                        if error_str and "timeout" in error_str.lower():
                            continue
                        svc = row.get("Service", "OTHER")
                        info = tc_conf_lookup.get(tc_id)
                        if not info:
                            continue
                        pct = info["pass_pct"]
                        entry = {
                            "tc_id": tc_id,
                            "name": row["Testcase Name"],
                            "pass_count": info["pass_count"],
                            "total_builds": info["total_builds"],
                            "pass_pct": pct,
                        }
                        if pct == 100:
                            buckets["high"].setdefault(svc, []).append(entry)
                        elif pct >= 80:
                            buckets["medium_high"].setdefault(svc, []).append(entry)
                        elif pct >= 50:
                            buckets["medium"].setdefault(svc, []).append(entry)
                        elif pct > 0:
                            buckets["medium_low"].setdefault(svc, []).append(entry)
                        else:
                            buckets["low"].setdefault(svc, []).append(entry)

                    def _sorted_svc(d: dict) -> dict:
                        for svc in d:
                            d[svc].sort(key=lambda x: x["tc_id"])
                        return dict(sorted(d.items()))

                    return {
                        "high":        {"label": "High",        "count": sum(len(v) for v in buckets["high"].values()),        "by_service": _sorted_svc(buckets["high"])},
                        "medium_high": {"label": "Med High",    "count": sum(len(v) for v in buckets["medium_high"].values()), "by_service": _sorted_svc(buckets["medium_high"])},
                        "medium":      {"label": "Med",         "count": sum(len(v) for v in buckets["medium"].values()),      "by_service": _sorted_svc(buckets["medium"])},
                        "medium_low":  {"label": "Med Low",     "count": sum(len(v) for v in buckets["medium_low"].values()),  "by_service": _sorted_svc(buckets["medium_low"])},
                        "low":         {"label": "Low",         "count": sum(len(v) for v in buckets["low"].values()),         "by_service": _sorted_svc(buckets["low"])},
                    }

                reg_confidence["known"] = _make_buckets(reg_known)
                reg_confidence["unknown"] = _make_buckets(reg_unknown)

    return {
        "platform": platform,
        "rc1": rc1_label,
        "rc2": rc2_label,
        "rc1_ota": rc1_ota,
        "rc2_ota": rc2_ota,
        "rc1_overview": {
            "total": rc1_total_all,
            "pass": rc1_total_pass,
            "fail": rc1_total_fail,
            "not_executed": rc1_total_ne,
            "not_applicable": rc1_total_na,
            "known_failures": rc1_known_count,
            "unknown_failures": rc1_unknown_count,
            "pass_pct": round(rc1_total_pass / rc1_total_all * 100, 1) if rc1_total_all else 0,
            "known_pct": round(rc1_known_count / rc1_total_all * 100, 1) if rc1_total_all else 0,
            "unknown_pct": round(rc1_unknown_count / rc1_total_all * 100, 1) if rc1_total_all else 0,
            "ne_pct": round(rc1_total_ne / rc1_total_all * 100, 1) if rc1_total_all else 0,
        },
        "overview": {
            "total": total_all,
            "pass": total_pass,
            "fail": total_fail,
            "not_executed": total_ne,
            "not_applicable": total_na,
            "known_failures": tc2_known_count,
            "unknown_failures": tc2_unknown_count,
            "pass_pct": round(total_pass / total_all * 100, 1) if total_all else 0,
            "known_pct": round(tc2_known_count / total_all * 100, 1) if total_all else 0,
            "unknown_pct": round(tc2_unknown_count / total_all * 100, 1) if total_all else 0,
            "ne_pct": round(total_ne / total_all * 100, 1) if total_all else 0,
        },
        "rc1_pass_by_service": rc1_pass_by_service,
        "rc1_known_fail_by_service": rc1_known_fail_by_service,
        "rc1_unknown_fail_by_service": rc1_unknown_fail_by_service,
        "rc1_ne_by_service": rc1_ne_by_service,
        "pass_by_service": pass_by_service,
        "known_fail_by_service": known_fail_by_service,
        "unknown_fail_by_service": unknown_fail_by_service,
        "ne_by_service": ne_by_service,
        "regressions": {
            "known_count": len(reg_known),
            "unknown_count": len(reg_unknown),
            "known_by_service": _reg_tc_list(reg_known),
            "unknown_by_service": _reg_tc_list(reg_unknown),
        },
        "persistent_failures": {
            "known_count": len(persist_known),
            "unknown_count": len(persist_unknown),
            "known_by_service": _reg_tc_list(persist_known),
            "unknown_by_service": _reg_tc_list(persist_unknown),
        },
        "regression_confidence": reg_confidence,
        "stable_tcs": {
            "count": len(stable),
            "by_service": _stable_tc_list(stable),
        },
        "fixed_tcs": {
            "count": len(fixed),
            "by_service": _fixed_tc_list(fixed),
        },
        "new_tcs": {
            "count": len(new_tcs),
            "by_service": new_tcs_by_service,
        },
        "removed_tcs": {
            "count": len(removed_tcs),
            "by_service": removed_tcs_by_service,
        },
        "graphs": {
            "known": known_graph,
            "unknown": unknown_graph,
        },
        "unique_services": unique_services,
    }


# ---------------------------------------------------------------------------
# Test Case Confidence — analyse pass-rate across multiple builds
# ---------------------------------------------------------------------------

class ConfidenceRequest(BaseModel):
    platform: str = "K1_US"
    builds: list[str] = []   # list of Jenkins job numbers
    build_urls: list[str] = []  # list of full Jenkins URLs (overrides builds)
    tc_ids: list[str] = []  # optional — filter to specific TC IDs only


@app.post("/test-case-confidence")
async def test_case_confidence(payload: ConfidenceRequest):
    """Return per-TC pass-rate data across several Jenkins builds.

    Buckets:
      - 100 %  → passed in every build
      - 80-99% → passed >=80% but not all
      - 50-79% → passed >=50% but <80%
      -  1-49% → passed >0% but <50%
    """
    from scripts.rc_comparison import (
        DEVICE_SERIALS,
        PLATFORMS,
        _jenkins_session,
        fetch_report_js,
        fetch_report_js_from_url,
        parse_report_data,
        aggregate_results,
        extract_tc_id,
    )
    import pandas as pd

    platform = payload.platform.strip().upper()
    if platform not in DEVICE_SERIALS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown platform '{platform}'. Valid: {', '.join(PLATFORMS)}",
        )

    # Determine whether we're using URLs or build numbers
    build_urls = [u.strip() for u in payload.build_urls if u.strip()]
    builds = [b.strip() for b in payload.builds if b.strip()]
    use_urls = len(build_urls) >= 2

    if not use_urls and len(builds) < 2:
        raise HTTPException(status_code=400, detail="At least 2 build numbers or URLs are required.")

    session = _jenkins_session()

    # Fetch & parse every build (auto-retry once on Jenkins auth failure)
    build_results: list[pd.DataFrame] = []
    items = build_urls if use_urls else builds
    resolved_builds: list[str] = []

    for item in items:
        label = item
        try:
            if use_urls:
                js, _job_base, build_num = fetch_report_js_from_url(item, session, use_cache=True)
                label = build_num
            else:
                build_num = item
                js = fetch_report_js(build_num, session, use_cache=True)
        except (SystemExit, Exception) as exc:
            if _is_jenkins_auth_error(str(exc)):
                logger.info(f"Jenkins auth failure for {label} — refreshing token and retrying…")
                refresh = _refresh_jenkins_token()
                if refresh["ok"]:
                    session = _jenkins_session()
                    try:
                        if use_urls:
                            js, _job_base, build_num = fetch_report_js_from_url(item, session, use_cache=True)
                            label = build_num
                        else:
                            js = fetch_report_js(item, session, use_cache=True)
                            build_num = item
                    except (SystemExit, Exception) as exc2:
                        raise HTTPException(status_code=500, detail=f"Build {label}: {exc2}")
                else:
                    raise HTTPException(status_code=500, detail=f"Build {label}: {exc}")
            else:
                raise HTTPException(status_code=500, detail=f"Build {label}: {exc}")
        _svc, tc_raw = parse_report_data(js)
        tc = aggregate_results(tc_raw)
        tc["TC_ID"] = tc["Testcase Name"].apply(extract_tc_id)
        tc["_build"] = build_num
        build_results.append(tc)
        resolved_builds.append(build_num)

    builds = resolved_builds

    all_tc = pd.concat(build_results, ignore_index=True)

    # Optional TC ID filter
    filter_tc_ids = [t.strip().upper() for t in payload.tc_ids if t.strip()]
    if filter_tc_ids:
        all_tc = all_tc[all_tc["TC_ID"].str.upper().isin(filter_tc_ids)]
        if all_tc.empty:
            raise HTTPException(status_code=404, detail="None of the specified TC IDs were found in the given builds.")

    # For each TC, count how many builds it appeared in and how many it passed
    grouped = all_tc.groupby(["TC_ID", "Testcase Name", "Service"]).agg(
        total_builds=("_build", "nunique"),
        pass_count=("Result", lambda x: (x.str.upper() == "PASS").sum()),
    ).reset_index()

    n_builds = len(builds)
    grouped["pass_pct"] = (grouped["pass_count"] / n_builds * 100).round(1)

    # Build buckets
    def _bucket_tc_list(df: pd.DataFrame) -> dict:
        result: dict[str, list] = {}
        for _, row in df.iterrows():
            svc = row.get("Service", "OTHER")
            entry = {
                "tc_id": row["TC_ID"],
                "name": row["Testcase Name"],
                "pass_count": int(row["pass_count"]),
                "total_builds": n_builds,
                "pass_pct": float(row["pass_pct"]),
            }
            result.setdefault(svc, []).append(entry)
        for svc in result:
            result[svc].sort(key=lambda x: x["tc_id"])
        return dict(sorted(result.items()))

    b100 = grouped[grouped["pass_pct"] == 100]
    b80  = grouped[(grouped["pass_pct"] >= 80) & (grouped["pass_pct"] < 100)]
    b50  = grouped[(grouped["pass_pct"] >= 50) & (grouped["pass_pct"] < 80)]
    b_low = grouped[(grouped["pass_pct"] > 0) & (grouped["pass_pct"] < 50)]
    b_zero = grouped[grouped["pass_pct"] == 0]

    return {
        "platform": platform,
        "builds": builds,
        "num_builds": n_builds,
        "total_tcs": len(grouped),
        "buckets": {
            "always_pass": {
                "label": "100 %",
                "count": len(b100),
                "by_service": _bucket_tc_list(b100),
            },
            "high": {
                "label": "80 – 99 %",
                "count": len(b80),
                "by_service": _bucket_tc_list(b80),
            },
            "medium": {
                "label": "50 – 79 %",
                "count": len(b50),
                "by_service": _bucket_tc_list(b50),
            },
            "low": {
                "label": "1 – 49 %",
                "count": len(b_low),
                "by_service": _bucket_tc_list(b_low),
            },
            "never_pass": {
                "label": "0 %",
                "count": len(b_zero),
                "by_service": _bucket_tc_list(b_zero),
            },
        },
    }


# ---------------------------------------------------------------------------
# TC Analysis — fetch TC metadata + automation logs for a single test case
# ---------------------------------------------------------------------------

class TCAnalysisRequest(BaseModel):
    build: str
    tc_id: str
    branch: str = ""
    device_id: str = ""          # optional — pick a specific device


@app.post("/tc-analysis")
async def tc_analysis(payload: TCAnalysisRequest):
    """Analyse a single test case: find device, timing, and extract logs."""
    import re as _re
    from datetime import datetime, timedelta
    from scripts.rc_comparison import (
        _jenkins_session,
        fetch_report_js,
        _extract_js_variable,
        extract_tc_id,
        JENKINS_BASE_URL,
    )

    build = payload.build.strip()
    target_tc = payload.tc_id.strip().upper()

    # Fast-fail if Jenkins auth is known to be broken (avoid 30s wait per request)
    if _jenkins_auth_is_broken():
        raise HTTPException(
            status_code=503,
            detail="Jenkins authentication is currently unavailable (token expired). Please update JENKINS_TOKEN in .env on the server and restart the backend."
        )

    session = _jenkins_session()

    # 1. Fetch scr.js (auto-retry once on Jenkins auth failure)
    try:
        js = fetch_report_js(build, session, use_cache=True)
    except (SystemExit, Exception) as exc:
        if _is_jenkins_auth_error(str(exc)):
            _mark_jenkins_auth_failed()
            logger.info("Jenkins auth failure on scr.js fetch — refreshing token and retrying…")
            refresh = _refresh_jenkins_token()
            if refresh["ok"]:
                session = _jenkins_session()
                try:
                    js = fetch_report_js(build, session, use_cache=True)
                except Exception as exc2:
                    raise HTTPException(status_code=500, detail=f"Failed to fetch report after token refresh: {exc2}")
            else:
                raise HTTPException(status_code=503, detail=f"Jenkins authentication failed — the API token has expired. Please generate a new token at Jenkins → User → Configure → API Token.")
        else:
            raise HTTPException(status_code=500, detail=f"Failed to fetch report: {exc}")

    # 2. Parse output to find the TC entry
    output_data: list[dict] = _extract_js_variable(js, "output")
    device_ids: list[str] = _extract_js_variable(js, "device_ids")

    matching = []
    for entry in output_data:
        entry_tc = extract_tc_id(entry.get("file_name", ""))
        if entry_tc.upper() == target_tc:
            matching.append(entry)

    if not matching:
        raise HTTPException(status_code=404, detail=f"TC '{target_tc}' not found in build {build}.")

    # Pick specific device if requested, otherwise first match
    requested_device = payload.device_id.strip()
    tc_entry = matching[0]
    if requested_device:
        for entry in matching:
            if entry.get("device_id", "") == requested_device:
                tc_entry = entry
                break
    device_id = tc_entry.get("device_id", "")
    start_time_str = tc_entry.get("start_time", "")
    end_time_str = tc_entry.get("end_time", "")
    time_taken = tc_entry.get("time_taken", "")
    test_status = tc_entry.get("test_status", "")
    file_name = tc_entry.get("file_name", "")
    description = tc_entry.get("description", "")
    service = tc_entry.get("service", "")

    # All device entries for this TC (for context)
    all_devices = []
    for entry in matching:
        all_devices.append({
            "device_id": entry.get("device_id", ""),
            "start_time": entry.get("start_time", ""),
            "end_time": entry.get("end_time", ""),
            "time_taken": entry.get("time_taken", ""),
            "status": entry.get("test_status", ""),
        })

    # 3. Fetch automation log for the device
    log_url = f"{JENKINS_BASE_URL}/{build}/Test_5freport/download/{device_id}.txt"
    log_lines: list[str] = []
    log_error = ""
    total_log_lines = 0

    # Parse start/end timestamps
    fmt = "%Y-%m-%d %H:%M:%S"
    try:
        start_dt = datetime.strptime(start_time_str, fmt)
    except (ValueError, TypeError):
        start_dt = None
    try:
        end_dt = datetime.strptime(end_time_str, fmt)
    except (ValueError, TypeError):
        end_dt = None

    def _fetch_log(sess):
        """Attempt to fetch automation log, return (log_lines, log_error, total)."""
        _log_lines = []
        _log_error = ""
        _total = 0
        try:
            resp = sess.get(log_url, timeout=30, allow_redirects=False)
            if resp.is_redirect:
                location = resp.headers.get("Location", "")
                if "commenceLogin" in location or "securityRealm" in location:
                    _log_error = "JENKINS_AUTH_FAILED"
                else:
                    _log_error = f"Log request was redirected (HTTP {resp.status_code})"
            elif resp.status_code != 200:
                _log_error = f"Log file not found (HTTP {resp.status_code})"
            else:
                all_lines = resp.text.split('\n')
                _total = len(all_lines)

                time_pat = _re.compile(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')
                if start_dt and end_dt:
                    in_range = False
                    for line in all_lines:
                        m = time_pat.search(line)
                        if m:
                            try:
                                line_dt = datetime.strptime(m.group(1), fmt)
                                if line_dt >= start_dt:
                                    in_range = True
                                if line_dt > end_dt:
                                    break
                            except ValueError:
                                pass
                        if in_range:
                            _log_lines.append(line)
                else:
                    _log_lines = all_lines[:500]
                    _log_error = "Could not parse start/end timestamps; showing first 500 lines."
        except Exception as exc:
            _log_error = f"Failed to fetch log: {exc}"
        return _log_lines, _log_error, _total

    log_lines, log_error, total_log_lines = _fetch_log(session)

    # Auto-refresh Jenkins token and retry once if auth failed
    if log_error == "JENKINS_AUTH_FAILED":
        logger.info("Jenkins auth failure on log fetch — refreshing token and retrying…")
        refresh = _refresh_jenkins_token()
        if refresh["ok"]:
            session = _jenkins_session()
            log_lines, log_error, total_log_lines = _fetch_log(session)

    # If still auth failed after refresh, show the user-facing message
    if log_error == "JENKINS_AUTH_FAILED":
        log_error = "Jenkins authentication failed — the API token may have expired. Please update JENKINS_TOKEN in .env."

    return {
        "build": build,
        "tc_id": target_tc,
        "branch": payload.branch,
        "file_name": file_name,
        "description": description,
        "service": service,
        "device_id": device_id,
        "start_time": start_time_str,
        "end_time": end_time_str,
        "time_taken": time_taken,
        "test_status": test_status,
        "all_devices": all_devices,
        "log_url": log_url,
        "total_log_lines": total_log_lines,
        "filtered_log_lines": len(log_lines),
        "log_error": log_error,
        "logs": log_lines,
        "steps": tc_entry.get("Test_Steps", []),
    }


# ---------------------------------------------------------------------------
# TC Source — fetch test case source code from GitHub
# ---------------------------------------------------------------------------

class TCSourceRequest(BaseModel):
    branch: str
    file_name: str


@app.post("/tc-source")
async def tc_source(payload: TCSourceRequest):
    """Fetch the Python source code for a test case from GitHub."""
    import os
    import base64
    import requests as _requests

    gh_token = os.getenv("GITHUB_TOKEN", "")
    if not gh_token:
        raise HTTPException(status_code=500, detail="GITHUB_TOKEN not configured on server.")

    branch = payload.branch.strip()
    file_name = payload.file_name.strip()
    if not branch or not file_name:
        raise HTTPException(status_code=400, detail="branch and file_name are required.")

    repo = "netradyne/nd_test_bot"
    base_path = "Test_Automation_Framework/src/test_cases"
    headers = {
        "Authorization": f"token {gh_token}",
        "Accept": "application/vnd.github.v3+json",
    }

    # Use Git tree API to recursively find the file
    try:
        # Get branch SHA
        branch_url = f"https://api.github.com/repos/{repo}/branches/{branch}"
        br_resp = _requests.get(branch_url, headers=headers, timeout=30)
        if br_resp.status_code == 404:
            raise HTTPException(status_code=404, detail=f"Branch '{branch}' not found.")
        br_resp.raise_for_status()
        commit_sha = br_resp.json()["commit"]["sha"]

        # Get recursive tree
        tree_url = f"https://api.github.com/repos/{repo}/git/trees/{commit_sha}?recursive=1"
        tree_resp = _requests.get(tree_url, headers=headers, timeout=60)
        tree_resp.raise_for_status()
        tree_data = tree_resp.json()

        # Find the matching file under test_cases/
        target = file_name.lower()
        matched_path = None
        for item in tree_data.get("tree", []):
            if item["type"] != "blob":
                continue
            if item["path"].lower().startswith(base_path.lower() + "/") and \
               item["path"].lower().endswith("/" + target):
                matched_path = item["path"]
                break
            # Also match if the filename is directly in test_cases/
            if item["path"].lower() == f"{base_path.lower()}/{target}":
                matched_path = item["path"]
                break

        if not matched_path:
            raise HTTPException(
                status_code=404,
                detail=f"File '{file_name}' not found under {base_path}/ on branch '{branch}'.",
            )

        # Fetch file content
        content_url = f"https://api.github.com/repos/{repo}/contents/{matched_path}?ref={branch}"
        content_resp = _requests.get(content_url, headers=headers, timeout=30)
        content_resp.raise_for_status()
        content_json = content_resp.json()

        # Decode base64 content
        source_code = base64.b64decode(content_json["content"]).decode("utf-8")

        return {
            "file_name": file_name,
            "file_path": matched_path,
            "branch": branch,
            "source_code": source_code,
            "github_url": f"https://github.com/{repo}/blob/{branch}/{matched_path}",
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"GitHub API error: {exc}")


# ---------------------------------------------------------------------------
# Device Logs
# ---------------------------------------------------------------------------

import re as _re
import subprocess as _subprocess
import shutil as _shutil
import os as _os
import sys as _sys

# Directory where logs_download.py and other scripts live
SCRIPTS_DIR = Path(__file__).parent / "scripts"

# Directory where logs_download.py deposits its output (runs relative to this)
DEVICE_LOGS_BASE = Path(__file__).parent / "device_logs_output"

# Regex to extract a 13-digit epoch_ms from a log line.
# Handles two formats produced by logs_download.py:
#   Raw:       1775491886123: 942892: SERVICE: I: ...
#   Processed: 2026-04-06 16:11:26: 1775491886123: 1775491886123: SERVICE: I : ...
# \b ensures we don't partially match longer numbers.
_EPOCH_RE = _re.compile(r"\b(\d{13}):")

# Regex to extract the log level (single letter surrounded by colons/spaces).
# Matches both ": I:" (raw) and ": I :" (processed) formats.
_LEVEL_RE = _re.compile(r":\s+([IEWDCVAF])\s*:")


def _extract_epoch_ms(line: str) -> int | None:
    m = _EPOCH_RE.search(line)
    return int(m.group(1)) if m else None


def _extract_level(line: str) -> str:
    m = _LEVEL_RE.search(line)
    return m.group(1) if m else "?"


class DeviceLogDownloadRequest(BaseModel):
    device_id: str
    date: str  # yyyy-mm-dd


class DeviceLogReadRequest(BaseModel):
    device_id: str
    date: str              # yyyy-mm-dd
    start_epoch_ms: int | None = None
    end_epoch_ms: int | None = None
    services: list[str] = []   # empty = all services
    search: str = ""           # substring filter


@app.get("/aws-sso/status")
async def aws_sso_status():
    """Check if the AWS SSO token for the s3view profile is still valid."""
    import shutil as _sh
    aws_bin = _sh.which("aws")
    if not aws_bin:
        return {"valid": False, "error": "aws CLI not found"}
    try:
        result = _subprocess.run(
            [aws_bin, "sts", "get-caller-identity", "--profile", "s3view"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            return {"valid": True}
        # Extract meaningful error
        err = result.stderr.strip() or result.stdout.strip()
        return {"valid": False, "error": err[:200]}
    except Exception as e:
        return {"valid": False, "error": str(e)[:200]}


@app.post("/device-logs/download")
async def device_log_download(payload: DeviceLogDownloadRequest):
    """Run logs_download.py for a device/date and stream output via SSE."""
    script_path = SCRIPTS_DIR / "logs_download.py"
    if not script_path.is_file():
        raise HTTPException(status_code=500, detail="logs_download.py not found in scripts/")

    DEVICE_LOGS_BASE.mkdir(parents=True, exist_ok=True)

    def stream():
        try:
            # Guard: verify aws CLI and s3view profile are available.
            # Extend PATH with common AWS CLI install locations so this works
            # even when uvicorn is run as a systemd service with a minimal PATH.
            extra_paths = [
                "/usr/local/bin", "/usr/bin", "/bin",
                "/usr/local/sbin", "/usr/sbin",
                str(Path.home() / ".local" / "bin"),
                "/snap/bin",
            ]
            env = _os.environ.copy()
            # Ensure HOME points to the actual user's home so aws finds ~/.aws/credentials
            if not env.get("HOME") or env["HOME"] == "/root":
                import pwd as _pwd
                try:
                    env["HOME"] = _pwd.getpwuid(_os.getuid()).pw_dir
                except Exception:
                    pass
            current_paths = env.get("PATH", "").split(":")
            # Build a deduplicated PATH with extra_paths prepended.
            seen: set[str] = set()
            merged: list[str] = []
            for p in (extra_paths + current_paths):
                if p and p not in seen:
                    seen.add(p)
                    merged.append(p)
            env["PATH"] = ":".join(merged)
            aws_bin = _shutil.which("aws", path=env["PATH"])
            if not aws_bin:
                yield f"data: {json.dumps({'type': 'stdout', 'text': 'ERROR: aws CLI not found in PATH. Install awscli and try again.'})}\n\n"
                yield f"data: {json.dumps({'type': 'exit', 'code': 1})}\n\n"
                return
            try:
                chk = _subprocess.run([aws_bin, "configure", "list-profiles"], capture_output=True, text=True, timeout=5, env=env)
                profiles = chk.stdout
            except Exception as profile_err:
                profiles = ""
                yield f"data: {json.dumps({'type': 'stdout', 'text': f'WARNING: could not read AWS profiles ({profile_err}). Attempting download anyway.'})}\n\n"
            if profiles and "s3view" not in profiles:
                yield f"data: {json.dumps({'type': 'stdout', 'text': 'ERROR: AWS profile s3view not configured. Run: aws configure --profile s3view'})}\n\n"
                yield f"data: {json.dumps({'type': 'exit', 'code': 1})}\n\n"
                return
            # Pre-flight: verify SSO token is valid before starting the download.
            try:
                token_chk = _subprocess.run(
                    [aws_bin, "sts", "get-caller-identity", "--profile", "s3view"],
                    capture_output=True, text=True, timeout=10, env=env,
                )
                if token_chk.returncode != 0:
                    err_text = (token_chk.stderr or token_chk.stdout).strip()
                    yield f"data: {json.dumps({'type': 'stdout', 'text': f'ERROR: AWS SSO token for profile s3view is expired or invalid. Run the aws-sso-refresh script and try again. ({err_text})'})}\n\n"
                    yield f"data: {json.dumps({'type': 'exit', 'code': 1})}\n\n"
                    return
            except Exception as token_err:
                yield f"data: {json.dumps({'type': 'stdout', 'text': f'WARNING: Could not verify SSO token ({token_err}). Attempting download anyway.'})}\n\n"
            proc = _subprocess.Popen(
                [_sys.executable, str(script_path), payload.device_id, payload.date],
                stdout=_subprocess.PIPE,
                stderr=_subprocess.STDOUT,
                text=True,
                cwd=str(DEVICE_LOGS_BASE),
                env=env,
            )
            for line in iter(proc.stdout.readline, ""):
                yield f"data: {json.dumps({'type': 'stdout', 'text': line.rstrip()})}\n\n"
            proc.wait()
            yield f"data: {json.dumps({'type': 'exit', 'code': proc.returncode})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'stdout', 'text': f'FATAL: {e}'})}\n\n"
            yield f"data: {json.dumps({'type': 'exit', 'code': 1})}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/device-logs/files")
async def list_device_log_files(
    device_id: str = Query(...),
    date: str = Query(...),
):
    """List all processed service log files available for a given device/date."""
    output_dir = DEVICE_LOGS_BASE / device_id / date / "output"
    if not output_dir.exists():
        return {"files": [], "output_dir": str(output_dir)}

    files = sorted(
        f.name.replace(".txt_out", "")
        for f in output_dir.iterdir()
        if f.name.endswith("_out")
    )
    return {"files": files, "output_dir": str(output_dir)}


@app.post("/device-logs/read")
async def read_device_logs(payload: DeviceLogReadRequest):
    """Read processed device logs filtered by epoch time range, services, and search text."""
    output_dir = DEVICE_LOGS_BASE / payload.device_id / payload.date / "output"
    if not output_dir.exists():
        raise HTTPException(
            status_code=404,
            detail=f"No logs found for device {payload.device_id} on {payload.date}. Download first.",
        )

    log_files = sorted(f for f in output_dir.iterdir() if f.name.endswith("_out"))
    if not log_files:
        raise HTTPException(status_code=404, detail="No processed log files found in output/.")

    result: list[dict] = []
    service_filter = set(payload.services) if payload.services else None
    search_lower = payload.search.lower() if payload.search else None

    for lf in log_files:
        service = lf.name.replace(".txt_out", "")
        if service_filter and service not in service_filter:
            continue

        try:
            content = lf.read_text(errors="ignore")
        except OSError:
            continue

        for line in content.splitlines():
            if not line.strip():
                continue

            epoch_ms = _extract_epoch_ms(line)

            # Epoch filter — skip unparseable lines when a time window is active
            if payload.start_epoch_ms or payload.end_epoch_ms:
                if epoch_ms is None:
                    continue
                if payload.start_epoch_ms and epoch_ms < payload.start_epoch_ms:
                    continue
                if payload.end_epoch_ms and epoch_ms > payload.end_epoch_ms:
                    continue

            # Search filter
            if search_lower and search_lower not in line.lower():
                continue

            result.append({
                "service": service,
                "epoch_ms": epoch_ms,
                "level": _extract_level(line),
                "line": line,
            })

    return {"count": len(result), "logs": result}


# ---------------------------------------------------------------------------
# AI Analysis — Ollama integration for TC failure analysis
# ---------------------------------------------------------------------------

OLLAMA_BASE = "http://localhost:11434"
OLLAMA_MODEL = "qwen2.5-coder:7b"

AI_SYSTEM_PROMPT = (
    "You are a senior QA engineer at Netradyne debugging a failed dashcam test case.\n\n"

    "FRAMEWORK: nd_test_bot. Test cases define a `dict_list` — a list of step dicts. "
    "Steps are named PreCondition_1, PreCondition_2, STEP_1, STEP_2, STEP_2_1, PostCondition_1, etc. "
    "Each step has: method (ObjectName_obj.method_name), parameters, save_result, validate_data. "
    "Steps execute sequentially. validate_data can branch (continue/exit/jump). "
    "Results saved as STEP_N_status='Pass'/'Fail' in global_results. "
    "use_result(var) references saved results from prior steps.\n\n"

    "TEST CASE STRUCTURAL RULES (CHECK THESE FIRST — structural bugs are common root causes):\n"
    "- Ordering: PreCondition_* steps → STEP_* steps → PostCondition_* steps. This order MUST be maintained.\n"
    "- Numbering: Each section must be numbered serially starting from 1. No gaps, no repeats.\n"
    "  DUPLICATE step names are a BUG: e.g. two 'PreCondition_6' in the dict_list means the framework "
    "overwrites PreCondition_6_status with the second one's result, and saved results from the first "
    "may be lost or inaccessible. The Step graph may also skip or mishandle duplicates.\n"
    "- Sub-steps like STEP_2_1 must come right after their parent (STEP_2).\n"
    "- If validate_data has action='exit' on fail, later steps never run — the test stops there.\n"
    "- CHECK: Are any step numbers skipped? Are any duplicated? Is the PreCondition→STEP→PostCondition "
    "order violated? These are authoring bugs, not device issues.\n\n"

    "KEY API OBJECTS: Calculator_obj (run_command_on_device, compare_equal, grep_string, "
    "get_current_timestamp), LogAnalyzer_obj (search_logs — searches device log files by name, "
    "e.g. 'power_mon' searches /home/ubuntu/.nddevice/log/power_monitor/), "
    "SerialCom_obj (call_relay — 'on'/'off' controls ignition relay), "
    "DeviceController_obj (reboot_device, delay), UpdateConfig_obj (download_config, change_param_value, "
    "upload_config, reupload_config), CloudApi_obj (ops_data_api), "
    "FilesController_obj (check_file_generation), SSHConnector_obj (reconnect_to_server), "
    "FileUtils_obj (file_availability).\n\n"

    "DEVICE FIRMWARE (C++ services, logs at /home/ubuntu/.nddevice/log/<service>/):\n"
    "- power_monitor [PWR]: Reads crank GPIO ('1'=CRANK_HIGH, '0'=CRANK_LOW). "
    "CRANK_LOW→process_crank_low()→initiate_shutdown(crank_shutdown_duration). "
    "CRANK_HIGH→process_crank_high()→cancel shutdown. "
    "check_uptime() logs 'low crank level; check_uptime is deactivated' when crank!=HIGH. "
    "keepalive_powerstate_thread sends ka_minified JSON to IDMS cloud on crank change — "
    "ka_minified contains BATTERY_ACTIVE, supercap_count, battery_voltage fields.\n"
    "- apm [APM]: IGNS_worker detects ignition via MSP/AON, writes to sysfs GPIO for power_monitor. "
    "If motion_detection enabled, waits vehicle_idle_time (default 180s) before IGNITION_OFF.\n"
    "- svc [SVC]: Watchdog. Services send keepalive ~30s. Missed→reboot.\n"
    "- Ignition flow: relay→MSP/AON→APM sysfs→power_monitor GPIO→process_crank_low/high\n\n"

    "LOG FORMAT: 'epoch_ms: counter: SERVICE: LEVEL: message' (I/E/W/D/C)\n\n"

    "ANALYSIS RULES:\n"
    "1. FIRST: Check test code structure for duplicate step names, numbering gaps, wrong ordering.\n"
    "2. EVERY claim MUST quote an actual log line: '> automation_log: <line>' or '> device_log: <line>'\n"
    "3. Use EXACT step names from the test data (PreCondition_1, STEP_1, etc.). NEVER invent S1, S2.\n"
    "4. Focus on the FAILING step and 3-4 steps before it. Do NOT enumerate every step.\n"
    "5. If search_logs failed, search the provided device logs yourself for that string.\n"
    "6. If no evidence exists, say 'No evidence in provided logs for X'.\n"
    "7. Never describe firmware abstractly without log evidence.\n"
    "8. If logs are insufficient, say what's missing.\n"
)

AI_USER_TEMPLATE = """A test case FAILED. Find the root cause using log evidence.

CRITICAL INSTRUCTIONS:
1. Use EXACT step names from TEST STEPS (PreCondition_1, STEP_3, etc.). NEVER invent S1, S2.
2. FIRST check TEST CODE for structural bugs: duplicate step names, numbering gaps/repeats,
   wrong ordering (PreCondition→STEP→PostCondition must be maintained).
   These are the MOST COMMON root causes.

FAILED STEP: {failed_step}

TEST STEPS (execution sequence):
{test_steps}

AUTOMATION LOGS:
{automation_logs}

DEVICE LOGS (from dashcam around time of failure):
{device_logs}

TEST CODE:
{test_code}

---
Respond CONCISELY:

## Test Code Structural Issues
Check the dict_list for: duplicate step names, numbering gaps, ordering violations.
If found, explain exactly what's wrong and how the framework would mishandle it.
If none found, say "No structural issues found."

## Root Cause
State the root cause. Quote the log lines that prove it:
> automation_log: [exact line]
> device_log: [exact line]

## Key Steps Analysis
Analyze ONLY the failing step and 2-3 steps before it (use exact step names from TEST STEPS above):
### [exact step name] — [Pass/Fail]
- **Automation**: > [quoted log line for this step]
- **Device**: > [quoted device log line from same time window] OR "No device log found"
- **Interpretation**: What this tells us

## Timeline
Key events with quoted timestamps from both logs.

## Possible Causes (ranked)
1. **[High]** — with log evidence
2. **[Medium]** — with evidence or "no evidence found"

## Confidence: High/Medium/Low
"""


OLLAMA_MODELS = [
    {"id": "qwen2.5-coder:3b", "label": "Qwen 3B (fast)", "size": "~2 GB"},
    {"id": "qwen2.5-coder:7b", "label": "Qwen 7B (balanced)", "size": "~4.7 GB"},
]


class AiAnalysisRequest(BaseModel):
    test_steps: str = ""
    failed_step: str = ""
    automation_logs: str = ""
    device_logs: str = ""
    test_code: str = ""
    model: str = OLLAMA_MODEL  # allow frontend to override


@app.get("/tc-analysis/ai/models")
async def tc_analysis_ai_models():
    """Return available AI models."""
    return {"models": OLLAMA_MODELS, "default": OLLAMA_MODEL}


@app.post("/tc-analysis/ai")
async def tc_analysis_ai(payload: AiAnalysisRequest):
    """Stream AI analysis of a failed TC via Ollama."""
    import httpx

    user_prompt = AI_USER_TEMPLATE.format(
        test_steps=payload.test_steps or "(not available)",
        failed_step=payload.failed_step or "(not available)",
        automation_logs=payload.automation_logs or "(not available)",
        device_logs=payload.device_logs or "(not available)",
        test_code=payload.test_code or "(not available)",
    )

    # Data is already smart-filtered by frontend; apply safety truncation.
    MAX_SECTION = 8000 if "3b" in (payload.model or OLLAMA_MODEL) else 15000
    for field_name in ("automation_logs", "device_logs", "test_code"):
        val = getattr(payload, field_name, "")
        if len(val) > MAX_SECTION:
            truncated = val[:MAX_SECTION] + f"\n... (truncated, {len(val)} chars total)"
            user_prompt = user_prompt.replace(val, truncated)

    # Context size: larger windows so model can actually read the logs
    ctx_size = 16384 if "3b" in (payload.model or OLLAMA_MODEL) else 32768
    max_tokens = 4096 if "3b" in (payload.model or OLLAMA_MODEL) else 6144
    logger.info(f"AI analysis: model={payload.model or OLLAMA_MODEL}, prompt_len={len(user_prompt)}, ctx={ctx_size}")

    async def stream():
        # Send an initial event so the frontend knows we're alive
        yield f"data: {json.dumps({'token': '', 'done': False, 'status': 'processing'})}\n\n"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_BASE}/api/chat",
                    json={
                        "model": payload.model or OLLAMA_MODEL,
                        "messages": [
                            {"role": "system", "content": AI_SYSTEM_PROMPT},
                            {"role": "user", "content": user_prompt},
                        ],
                        "stream": True,
                        "options": {
                            "temperature": 0.3,
                            "num_predict": max_tokens,
                            "num_ctx": ctx_size,
                        },
                    },
                ) as resp:
                    if resp.status_code != 200:
                        body = await resp.aread()
                        yield f"data: {json.dumps({'error': f'Ollama returned HTTP {resp.status_code}: {body.decode()[:300]}'})}\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            chunk = json.loads(line)
                            token = chunk.get("message", {}).get("content", "")
                            done = chunk.get("done", False)
                            yield f"data: {json.dumps({'token': token, 'done': done})}\n\n"
                            if done:
                                return
                        except json.JSONDecodeError:
                            pass
        except httpx.ConnectError:
            yield f"data: {json.dumps({'error': 'Cannot connect to Ollama at ' + OLLAMA_BASE + '. Is it running?'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Deep AI Analysis — Map-Reduce approach
# ---------------------------------------------------------------------------

DEEP_MAP_PROMPT = """You are analyzing a CHUNK of data from a failed Netradyne dashcam test case.
Extract ONLY findings relevant to the failure. QUOTE the exact log line for each finding.

Look for: errors, STEP_N_status Pass/Fail, relay changes, timestamps, gaps > 30s,
crank/ignition/shutdown/POWERMON/IGNS/keepalive messages, service crashes.
If search_logs failed, search this chunk for that string yourself.

Format:
- **Finding**: [description]
  > log: [exact quoted line]

If nothing relevant: "No relevant findings in this chunk."
"""

DEEP_REDUCE_PROMPT = """You are a senior QA engineer analyzing a failed Netradyne dashcam test case.
Below are chunk summaries with quoted log lines from automation and device logs.

Firmware context: power_monitor reads crank GPIO (process_crank_low/high, check_uptime),
APM writes ignition to sysfs, SVC is watchdog. Flow: relay→APM→sysfs→power_monitor.

CRITICAL: Use EXACT step names from TEST STEPS (e.g. PreCondition_1, STEP_3). Never invent names.
Every claim MUST quote a log line from the chunk summaries.

FAILED STEP: {failed_step}

TEST STEPS: {test_steps}

--- CHUNK SUMMARIES ---
{chunk_summaries}

---
## Root Cause
With quoted log evidence: > log: [exact line]

## Key Steps Analysis
Only the failing step and 2-3 steps before it (use exact step names):
### [step name] — [Pass/Fail]
- **Automation**: > [quoted line]
- **Device**: > [quoted line] or "No device log found"

## Timeline
Key events with quoted timestamps.

## Possible Causes (ranked)
With log evidence for each.

## Confidence: High/Medium/Low
"""


class DeepAiRequest(BaseModel):
    test_steps: str = ""
    failed_step: str = ""
    automation_logs: str = ""
    device_logs: str = ""
    test_code: str = ""
    model: str = OLLAMA_MODEL


@app.post("/tc-analysis/ai/deep")
async def tc_analysis_ai_deep(payload: DeepAiRequest):
    """Deep AI analysis using Map-Reduce: chunk all data, summarize each, then synthesize."""
    import httpx

    model = payload.model or OLLAMA_MODEL
    ctx_size = 16384 if "3b" in model else 32768
    # Much larger chunks to keep total manageable (target 8-12 chunks max)
    MAX_CHUNKS_PER_SECTION = 4   # max chunks per data section
    MAX_TOTAL_CHUNKS = 12        # absolute cap
    CHUNK_SIZE = 10000 if "3b" in model else 20000  # chars per chunk

    chunks: list[dict] = []

    def add_chunks(label: str, text: str, max_parts: int = MAX_CHUNKS_PER_SECTION):
        if not text or text == "(not available)" or len(text.strip()) < 20:
            return
        lines = text.split("\n")
        total_chars = len(text)

        # If text fits in max_parts chunks, chunk normally
        if total_chars <= CHUNK_SIZE * max_parts:
            chars = 0
            batch: list[str] = []
            part = 1
            for line in lines:
                if chars + len(line) > CHUNK_SIZE and batch:
                    chunks.append({"label": f"{label} (part {part})", "content": "\n".join(batch)})
                    batch = []
                    chars = 0
                    part += 1
                batch.append(line)
                chars += len(line) + 1
            if batch:
                chunks.append({"label": f"{label} (part {part})", "content": "\n".join(batch)})
        else:
            # Data too large — evenly sample max_parts chunks across the data
            # Always include first and last portions, sample middle
            lines_per_chunk = max(1, len(lines) // max_parts)
            for p in range(max_parts):
                start_idx = p * (len(lines) // max_parts)
                end_idx = min(start_idx + lines_per_chunk, len(lines))
                chunk_lines = lines[start_idx:end_idx]
                # Trim to CHUNK_SIZE chars
                content = ""
                for l in chunk_lines:
                    if len(content) + len(l) + 1 > CHUNK_SIZE:
                        break
                    content += l + "\n"
                if content.strip():
                    chunks.append({
                        "label": f"{label} (part {p + 1}/{max_parts}, lines {start_idx+1}-{end_idx})",
                        "content": content.strip(),
                    })

    add_chunks("AUTOMATION LOGS", payload.automation_logs)
    add_chunks("DEVICE LOGS", payload.device_logs)
    add_chunks("TEST SOURCE CODE", payload.test_code, max_parts=2)  # code rarely needs many chunks

    # Hard cap
    if len(chunks) > MAX_TOTAL_CHUNKS:
        chunks = chunks[:MAX_TOTAL_CHUNKS]

    total_chunks = len(chunks)
    logger.info(f"Deep AI: model={model}, total_chunks={total_chunks}, ctx={ctx_size}")

    async def ollama_chat(client: httpx.AsyncClient, system: str, user: str, max_tokens: int = 1024) -> str:
        resp = await client.post(
            f"{OLLAMA_BASE}/api/chat",
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "stream": False,
                "options": {
                    "temperature": 0.2,
                    "num_predict": max_tokens,
                    "num_ctx": ctx_size,
                },
            },
            timeout=300.0,
        )
        if resp.status_code != 200:
            raise Exception(f"Ollama HTTP {resp.status_code}: {resp.text[:200]}")
        return resp.json().get("message", {}).get("content", "")

    async def deep_stream():
        yield f"data: {json.dumps({'phase': 'map', 'chunk': 0, 'total': total_chunks, 'status': 'starting'})}\n\n"

        if total_chunks == 0:
            yield f"data: {json.dumps({'error': 'No data provided for deep analysis.'})}\n\n"
            return

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as client:
                summaries: list[str] = []
                for i, chunk in enumerate(chunks):
                    yield f"data: {json.dumps({'phase': 'map', 'chunk': i + 1, 'total': total_chunks, 'label': chunk['label'], 'status': 'processing'})}\n\n"

                    user_msg = f"DATA TYPE: {chunk['label']}\n\n{chunk['content']}"
                    try:
                        summary = await ollama_chat(client, DEEP_MAP_PROMPT, user_msg, max_tokens=512)
                        summaries.append(f"### {chunk['label']}\n{summary}")
                        yield f"data: {json.dumps({'phase': 'map', 'chunk': i + 1, 'total': total_chunks, 'label': chunk['label'], 'status': 'done', 'summary_preview': summary[:120]})}\n\n"
                    except Exception as e:
                        summaries.append(f"### {chunk['label']}\n(Error: {str(e)[:100]})")
                        yield f"data: {json.dumps({'phase': 'map', 'chunk': i + 1, 'total': total_chunks, 'label': chunk['label'], 'status': 'error', 'error': str(e)[:100]})}\n\n"

                yield f"data: {json.dumps({'phase': 'reduce', 'status': 'starting'})}\n\n"

                reduce_prompt = DEEP_REDUCE_PROMPT.format(
                    failed_step=payload.failed_step or "(not available)",
                    test_steps=payload.test_steps or "(not available)",
                    chunk_summaries="\n\n".join(summaries),
                )

                async with client.stream(
                    "POST",
                    f"{OLLAMA_BASE}/api/chat",
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": AI_SYSTEM_PROMPT},
                            {"role": "user", "content": reduce_prompt},
                        ],
                        "stream": True,
                        "options": {
                            "temperature": 0.3,
                            "num_predict": 6144 if "7b" in model else 4096,
                            "num_ctx": ctx_size,
                        },
                    },
                ) as resp:
                    if resp.status_code != 200:
                        body = await resp.aread()
                        yield f"data: {json.dumps({'error': f'Ollama HTTP {resp.status_code}: {body.decode()[:300]}'})}\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            chunk_data = json.loads(line)
                            token = chunk_data.get("message", {}).get("content", "")
                            done = chunk_data.get("done", False)
                            yield f"data: {json.dumps({'phase': 'reduce', 'token': token, 'done': done})}\n\n"
                            if done:
                                return
                        except json.JSONDecodeError:
                            pass

        except httpx.ConnectError:
            yield f"data: {json.dumps({'error': 'Cannot connect to Ollama at ' + OLLAMA_BASE})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        deep_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
