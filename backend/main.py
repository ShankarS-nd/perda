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
            timeout=30,
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
    rc1: str
    rc2: str
    platform: str = "K1_US"
    force_refresh: bool = False


@app.post("/test-report-summary")
async def test_report_summary(payload: TestReportRequest):
    """Return structured dashboard data comparing two Jenkins builds.

    Reuses parsing logic from scripts/rc_comparison.py.
    """
    # Import at call-time to avoid circular / heavy init on startup
    from scripts.rc_comparison import (
        DEVICE_SERIALS,
        PLATFORMS,
        SERIAL_LOOKUP,
        _jenkins_session,
        fetch_report_js,
        fetch_dast_known_unknown_counts,
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

    session = _jenkins_session()

    use_cache_rc2 = not payload.force_refresh

    try:
        # rc1 (previous/preset build) — always served from disk cache
        rc1_js = fetch_report_js(payload.rc1.strip(), session, use_cache=True)
        # rc2 (current build) — served from cache unless force_refresh=True
        rc2_js = fetch_report_js(payload.rc2.strip(), session, use_cache=use_cache_rc2)
    except (SystemExit, Exception) as exc:
        if _is_jenkins_auth_error(str(exc)):
            logger.info("Jenkins auth failure in test-report-summary — refreshing token and retrying…")
            refresh = _refresh_jenkins_token()
            if refresh["ok"]:
                session = _jenkins_session()
                try:
                    rc1_js = fetch_report_js(payload.rc1.strip(), session, use_cache=True)
                    rc2_js = fetch_report_js(payload.rc2.strip(), session, use_cache=use_cache_rc2)
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
    dast_cache_file = dast_cache_dir / f"{payload.rc2.strip()}.json"
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
            dast_known, dast_unknown = fetch_dast_known_unknown_counts(
                payload.rc2.strip(), session,
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

    # ── Persistent failures (Fail → Fail) ──
    persistent = merged[
        (merged["RC1_Result"] == "FAIL") & (merged["RC2_Result"] == "FAIL")
    ].copy()
    persist_known = persistent[persistent["RC2_Linked"].apply(is_linked)].copy()
    persist_unknown = persistent[~persistent["RC2_Linked"].apply(is_linked)].copy()

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
        "rc1": payload.rc1.strip(),
        "rc2": payload.rc2.strip(),
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
        "graphs": {
            "known": known_graph,
            "unknown": unknown_graph,
        },
    }


# ---------------------------------------------------------------------------
# Test Case Confidence — analyse pass-rate across multiple builds
# ---------------------------------------------------------------------------

class ConfidenceRequest(BaseModel):
    platform: str = "K1_US"
    builds: list[str]   # list of Jenkins job numbers
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

    builds = [b.strip() for b in payload.builds if b.strip()]
    if len(builds) < 2:
        raise HTTPException(status_code=400, detail="At least 2 build numbers are required.")

    session = _jenkins_session()

    # Fetch & parse every build (auto-retry once on Jenkins auth failure)
    build_results: list[pd.DataFrame] = []
    for build_num in builds:
        try:
            js = fetch_report_js(build_num, session, use_cache=True)
        except (SystemExit, Exception) as exc:
            if _is_jenkins_auth_error(str(exc)):
                logger.info(f"Jenkins auth failure for build {build_num} — refreshing token and retrying…")
                refresh = _refresh_jenkins_token()
                if refresh["ok"]:
                    session = _jenkins_session()
                    try:
                        js = fetch_report_js(build_num, session, use_cache=True)
                    except (SystemExit, Exception) as exc2:
                        raise HTTPException(status_code=500, detail=f"Build {build_num}: {exc2}")
                else:
                    raise HTTPException(status_code=500, detail=f"Build {build_num}: {exc}")
            else:
                raise HTTPException(status_code=500, detail=f"Build {build_num}: {exc}")
        _svc, tc_raw = parse_report_data(js)
        tc = aggregate_results(tc_raw)
        tc["TC_ID"] = tc["Testcase Name"].apply(extract_tc_id)
        tc["_build"] = build_num
        build_results.append(tc)

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
    session = _jenkins_session()

    # 1. Fetch scr.js (auto-retry once on Jenkins auth failure)
    try:
        js = fetch_report_js(build, session, use_cache=True)
    except (SystemExit, Exception) as exc:
        if _is_jenkins_auth_error(str(exc)):
            logger.info("Jenkins auth failure on scr.js fetch — refreshing token and retrying…")
            refresh = _refresh_jenkins_token()
            if refresh["ok"]:
                session = _jenkins_session()
                try:
                    js = fetch_report_js(build, session, use_cache=True)
                except Exception as exc2:
                    raise HTTPException(status_code=500, detail=f"Failed to fetch report after token refresh: {exc2}")
            else:
                raise HTTPException(status_code=500, detail=f"Jenkins authentication failed and token refresh did not help: {exc}")
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
            resp = sess.get(log_url, timeout=120, allow_redirects=False)
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
    "You are a senior QA automation engineer at Netradyne debugging a failed dashcam/set-top-box test case. "
    "You have deep expertise in the nd_test_bot Test Automation Framework (repo: netradyne/nd_test_bot). "
    "Analyze the provided logs, test steps, and code to find the root cause of the failure.\n\n"

    "=== nd_test_bot FRAMEWORK KNOWLEDGE ===\n\n"

    "ARCHITECTURE OVERVIEW:\n"
    "The framework lives at Test_Automation_Framework/. Entry point is src/main.py (class TestAutomationDevice). "
    "Test cases are Python files under src/test_cases/ (and subdirectories like SANITY/, OTACHECK/, Internal_Test_Cases/). "
    "Each test case defines a `dict_list` — a list of step dictionaries that the DictionaryApi engine processes.\n\n"

    "EXECUTION FLOW:\n"
    "1. main.py → handle_command_args() parses device IDs and test case IDs\n"
    "2. TestExecutor (Lib/Initialiser_api/execution.py) iterates test cases from MongoDB\n"
    "3. test_cases_helper (Lib/Initialiser_api/test_cases_helper.py) loads dict_list from TC file via importlib\n"
    "4. DictionaryApi.process_dict(dict_list) creates a Workflow → builds a Step graph → executes from STEP_1\n"
    "5. Each Step.execute() calls the method on the appropriate API object, handles save_result, validate_data\n"
    "6. Results stored in global_results dict (e.g. STEP_1_status='Pass'), test steps in global_test_steps list\n"
    "7. Output written to JSON (output_json_api.create_json) and MongoDB (MongoDBUpdater)\n\n"

    "TEST CASE STRUCTURE (dict_list format):\n"
    "Each step dict has a STEP_N key with:\n"
    "  - 'method': 'ObjectName_obj.method_name' — calls the API object's method\n"
    "  - 'parameters': [...] — args passed to the method. 'use_result(var_name)' references saved results\n"
    "  - 'save_result': ['var1', 'var2'] — saves method return values to global_results for later steps\n"
    "  - 'validate_data': [{condition, pass_method, fail_method}] — conditional branching\n"
    "    - condition: Python expression evaluated against global_results (e.g. \"STEP_1_status == 'Pass'\")\n"
    "    - pass_method/fail_method: {message, action} where action is 'continue', 'exit', or 'jump to STEP_N'\n"
    "    - 'force_to': overrides status (e.g. force_to='Pass' makes a failure count as pass)\n"
    "  - 'save_status': [...] — saves Pass/Fail status to named variables\n"
    "  - 'save_data': [...] — saves key:value pairs to global_results\n"
    "  - 'loop': N — repeat the step N times\n"
    "  - 'sleep': seconds — wait between loop iterations\n"
    "  - 'Run_Test': 'filename.py' or ['file1.py', 'file2.py'] — execute sub-test-cases\n"
    "  - 'trigger': {method, steps, parameters, loop, sleep} — background thread execution\n"
    "  - 'wait_method': 'ObjectName_obj.method' — async polling until condition met or timeout\n\n"

    "API OBJECTS AVAILABLE IN STEPS:\n"
    "  - Calculator_obj (calculator_api.py): run_command_on_device, run_command_on_Automation_device, "
    "get_current_time, div, parse_json, grep_string, compare_time_difference, get_device_info, "
    "Download_summary, intravel_check, compare_equal, issubset, reduce_available_space\n"
    "  - FilesController_obj (files_api.py): check_file_generation(types, cam, epoch_num), "
    "check_epoch_in_ND_Input, check_file_generation_in_ND_INPUT, count_files_in_path, get_epoch_from_file\n"
    "  - DeviceController_obj (reboot_device.py): reboot_device\n"
    "  - FileUtils_obj (file_utils.py): file_availability, remove_file\n"
    "  - CloudApi_obj (cloud_api.py): ops_data_api (calls IDMS keepalive/upload endpoints)\n"
    "  - LogAnalyzer_obj (log_analyser.py): search_logs(log_name, search_strings)\n"
    "  - Log_obj (log_api.py): log_upload_test(services)\n"
    "  - ServiceController_obj (service_controller.py): restart_service\n"
    "  - UpdateConfig_obj (Config_api.py): reupload_config\n"
    "  - CameraController_obj (camera_api.py): camera operations\n"
    "  - SerialCom_obj (SerialCom_api.py): send_files_to_device, get_output_file\n"
    "  - SSHConnector_obj (ssh.py): reconnect_to_server — SSH into device under test\n"
    "  - DicitionaryApi_obj / command_dict_obj (cmd_dict.py): get_remote_filepath(key, filename)\n"
    "  - DeviceSpace_obj (device_space_api.py): device storage management\n"
    "  - LEDController_obj (led_api.py): LED control\n"
    "  - SendMsgServer_obj (send_msg_server.py): message server control\n"
    "  - RunRelayAutomation_obj (relay_automation_api.py): ignition relay control\n\n"

    "METHOD RETURN CONVENTION:\n"
    "Most API methods return (test_status, result) tuple. test_status is 'Pass'/'Fail'. "
    "The framework checks result[0] ('Pass'/'Fail'/True/False) to set STEP_N_status in global_results. "
    "Additional return values are saved to save_result variables.\n\n"

    "DEVICE TYPES:\n"
    "  - Krait (K1/K2): paths use /data/nd_files/, /home/iriscli/\n"
    "  - Bagheera (B2/B3): paths use /home/ubuntu/.nddevice/, /home/ubuntu/config/\n"
    "  - Device logs stored at: /home/iriscli/ND_INPUT/, /home/iriscli/ND_OUTPUT/\n"
    "  - Config at: /data/nd_files/config/ (Krait) or /home/ubuntu/config/ (Bagheera)\n"
    "  - SD card path varies by device type (from cmd_dict)\n\n"

    "CLOUD/IDMS ENDPOINTS:\n"
    "  - Staging: https://idms-staging.netradyne.com/restserver/api/v1/\n"
    "  - Production: https://idms.netradyne.com/restserver/api/v1/\n"
    "  - OTA downloads, keepalive calls, observation uploads all go through IDMS\n\n"

    "KEY SERVICES ON DEVICE (from nd_device_services repo — C++ firmware):\n"
    "  Services communicate via nd_msgq message queues. Each sends keepalive to SVC.\n"
    "  Log tag in brackets. Logs at /home/ubuntu/.nddevice/log/<service>/\n\n"

    "  - power_monitor [PWR]: THE MOST CRITICAL SERVICE FOR IGNITION TESTS.\n"
    "    * Reads crank voltage via GPIO pin (gpio_crank_level_info_file): '1'=CRANK_HIGH, '0'=CRANK_LOW\n"
    "    * Has 4 threads: gpio171_interrupt_thread (GPIO interrupt for crank changes), "
    "direct_poling_thread (polls crank voltage, uptime, temperature, battery voltage every cycle), "
    "shutdown_poling_thread (monitors shutdown timer and executes shutdown/suspend), "
    "keepalive_powerstate_thread (sends keepalive to IDMS cloud on crank change)\n"
    "    * check_uptime() function: if crank is NOT HIGH, logs 'low crank level; check_uptime is deactivated' and returns false. "
    "This is THE message many ignition-off tests search for.\n"
    "    * process_crank_low(): called when CRANK_LOW detected → sends IGNITION_OFF to nd_central & btfv → "
    "initiates shutdown with crank_shutdown_duration (default 3 min) → SHUTDOWN_FOR_IGNITION_OFF\n"
    "    * process_crank_high(): called when CRANK_HIGH detected → cancels shutdown → postpones by 6 min → "
    "sends IGNITION_ON to nd_central & btfv → resets lowpower_wakeups to 0\n"
    "    * initiate_shutdown(secs, reason): sets RTC wakeup timer, starts shutdown countdown. "
    "Reasons: SHUTDOWN_FOR_BAD_VOLTAGE, SHUTDOWN_FOR_IGNITION_OFF, SHUTDOWN_FOR_CYCLIC_REBOOT, "
    "SHUTDOWN_FOR_CAM_CRASH, SHUTDOWN_FOR_SVC_KEEPALIVE_FAILURE, SHUTDOWN_FOR_LOWPOWER_WAKEUP, etc.\n"
    "    * ignition_cb_func(): callback triggered by GPIO interrupt when crank voltage changes, "
    "sends POWERMON_CRANK_CHANGE message to power_monitor_msg_loop\n"
    "    * power_monitor_msg_loop(): main message handler, processes POWERMON_CRANK_CHANGE, "
    "POWERMON_DIRECTPOLL_CRANK_CHANGE, POWERMON_MAXTIMEOUT, POWERMON_BAD_BATTERY_VOLTAGE, etc.\n"
    "    * IMPORTANT: 'low crank level; check_uptime is deactivated' is logged in check_uptime() which "
    "is called when process_crank_high() runs AND crank is actually LOW. This means: if check_uptime sees "
    "crank != CRANK_HIGH, it logs this message. So if this message is NOT found, it means either: "
    "(a) check_uptime was never called (no crank HIGH event after crank went LOW), "
    "(b) power_monitor service crashed/wasn't running, "
    "(c) crank level never actually changed (relay didn't work), "
    "(d) GPIO file couldn't be read (hardware issue)\n\n"

    "  - apm (Advanced Power Management) [APM]: Manages ignition/motion detection\n"
    "    * Has workers: IGNS_worker (ignition), IMU_worker (accelerometer), GPS_worker, SC_worker (supercap)\n"
    "    * IGNS_worker.intr_func(): registers ignCallback for ignition interrupt from MSP/AON\n"
    "    * IGNS_worker.read_status(): reads current ignition via get_ignition_status() with debounce "
    "(3 reads at 50ms intervals, all must agree)\n"
    "    * start_monitor(): main loop — checks all workers, writes pseudo-ignition to sysfs. "
    "If motion detection enabled: waits vehicle_idle_time (default 180s) before writing IGNITION_OFF\n"
    "    * write_to_sysfs(): writes ignition status to GPIO file that power_monitor reads\n"
    "    * KEY FLOW: Physical ignition → MSP/AON detects → APM IGNS interrupt → write_to_sysfs(IGNITION_OFF/ON) "
    "→ power_monitor GPIO interrupt/poll detects change → process_crank_low/high()\n\n"

    "  - svc (Service Supervisor) [SVC]: Watchdog and service health monitor\n"
    "    * Receives keepalive from ALL services every ~30 seconds\n"
    "    * If a service misses keepalive for longer than its timeout (default 120s), "
    "stops kicking hardware watchdog → device reboots\n"
    "    * do_house_keeping(): checks each service's health, triggers reboot via power_monitor if unhealthy\n"
    "    * Also manages disk monitoring (diskmon), config file recovery, button events\n"
    "    * Logs: 'Keep alive timeout: <service_name>' when a service becomes unhealthy\n\n"

    "  - service_mon (Service Monitor) [SM]: Receives error/start/stop messages from ALL services via NDService\n"
    "    * Each service creates NDService object: nd_service_obj = NDService::get_service_obj(TAG)\n"
    "    * send_err_msg(error_code, aux_code, message) — logged as health stats\n"
    "    * Error codes like SM_E_PM_CRANK_LEVEL_FAIL, SM_E_APM_MSP_FAIL, SM_E_SVC_KEEP_ALIVE_TIMEOUT, etc.\n\n"

    "  - bagheera / nd_central [NDC]: Main recording and processing service\n"
    "    * Manages cameras (outward, inward, side), video recording in 1-minute sessions\n"
    "    * Receives IGNITION ON/OFF from power_monitor → adjusts processing_mode (0=recording, 1=low power)\n"
    "    * Generates files in ND_INPUT/: .mp4 (video), STATE files, .chm (checksum), summary.json\n"
    "    * record_component_errorcb(): on camera crash → sends REQ_POWERMON_CAM_CRASH_TO_REBOOT to power_monitor\n"
    "    * Uses inference engine for ML alert detection\n\n"

    "  - circular_buffer [CB]: Manages video file lifecycle and SD card storage\n"
    "    * Monitors SD card health, triggers sdcard_recovery if SD goes read-only\n"
    "    * Manages file retention: oldest files deleted when space needed\n"
    "    * sdcard_recovery_thread: if SD card stays read-only too long, requests reboot via power_monitor\n\n"

    "  - uploader [UPL]: Uploads files (video, logs, observations) to IDMS cloud\n"
    "    * Uploads video files, summary.json, observations to IDMS\n"
    "    * health_stats_utils: periodically uploads health statistics\n"
    "    * Logs network info, retry counts, upload success/failure\n\n"

    "  - otacheck: OTA update checker\n"
    "    * Uses otacheck.pid, otacheck_state.txt, otacheck_count.txt\n"
    "    * Checks IDMS for available firmware updates\n"
    "    * installer_app: downloads and applies OTA updates, stops services during install\n\n"

    "  - nd_suspendresume: Handles device suspend/resume cycle\n"
    "    * Stops services before suspend: cam_rec, bagheera, circular_buffer, uploader, btfv, etc.\n"
    "    * Restarts services after resume in correct order\n"
    "    * Manages LED states during boot/suspend\n\n"

    "  - nd_shutdown: Runs during system shutdown\n"
    "    * Checks crank level: if CRANK_HIGH at shutdown time, does POR (Power On Reset)\n"
    "    * Manages PMIC watchdog during shutdown\n\n"

    "  - btfv [BTFV]: Bluetooth Face Verification\n"
    "    * BLE scanning for driver identification\n"
    "    * Receives ignition status from power_monitor\n\n"

    "  - wifi_mgr: WiFi management service\n"
    "  - diagnostic: SD card health monitoring, fsck recovery\n"
    "  - scheduler_manager: Task scheduling\n"
    "  - time_sync: NTP time synchronization\n"
    "  - cam_rec: Camera recording management\n"
    "  - speed: Speed detection via OBD/GPS\n"
    "  - awsiot: AWS IoT communication, device registration\n"
    "  - nd_sam: Security Authentication Module\n\n"

    "IGNITION EVENT FLOW (END-TO-END from nd_device_services source code):\n"
    "  === IGNITION OFF (relay off in test) ===\n"
    "  1. Physical relay cuts ignition wire voltage\n"
    "  2. Hardware (MSP/AON chip) detects voltage drop on ignition line\n"
    "  3. APM's IGNS_worker.intr_func() triggers ignCallback()\n"
    "  4. ignCallback() reads ignition status with debounce (3 reads at 50ms each)\n"
    "  5. If confirmed IGNITION_OFF → IGNS_worker.filter_func() resets IGNS bit\n"
    "  6. APM.start_monitor() detects STATIONARY → writes IGNITION_OFF to sysfs file\n"
    "    (NOTE: if apm_motion_detection enabled, waits vehicle_idle_time=180s before writing!)\n"
    "  7. power_monitor detects GPIO change via gpio171_interrupt_thread → ignition_cb_func()\n"
    "     OR via direct_poling_thread → direct_polling_crank_level()\n"
    "  8. power_monitor_msg_loop receives POWERMON_CRANK_CHANGE with CRANK_LOW\n"
    "  9. process_crank_low() executes:\n"
    "     a. Sets crank_low_registered = true\n"
    "     b. Calls initiate_shutdown(crank_shutdown_duration=180s, SHUTDOWN_FOR_IGNITION_OFF)\n"
    "     c. Sends IGNITION_OFF status to nd_central and btfv via message queues\n"
    "  10. check_uptime() is called (from process_crank_high on next CRANK_HIGH event or from\n"
    "      direct_poling_thread). Since crank != CRANK_HIGH, it logs:\n"
    "      'low crank level; check_uptime is deactivated'\n"
    "  11. shutdown_poling_thread monitors the timer. When time expires:\n"
    "      → sync filesystem → suspend or shutdown device\n"
    "  12. nd_central switches to processing_mode=1 (low power)\n"
    "  13. keepalive_powerstate_thread sends keepalive to IDMS with power_state='0' (ignition off)\n\n"

    "  === IGNITION ON (relay on in test) ===\n"
    "  1. Physical relay restores ignition wire voltage\n"
    "  2. MSP/AON detects voltage rise → interrupt\n"
    "  3. APM detects IGNITION_ON → writes to sysfs\n"
    "  4. power_monitor detects CRANK_HIGH via GPIO/polling\n"
    "  5. process_crank_high(): cancels pending shutdown, postpones by 6 min\n"
    "  6. Sends IGNITION_ON to nd_central → recording resumes in processing_mode=0\n"
    "  7. nd_central starts new recording session\n"
    "  8. check_uptime() now returns true if uptime exceeds max_uptime_secs (cyclic reboot)\n\n"

    "  === WHY 'low crank level; check_uptime is deactivated' MIGHT NOT APPEAR ===\n"
    "  1. APM motion detection delay: if apm_motion_detection is enabled, APM waits 180s "
    "before writing IGNITION_OFF to sysfs. Test may search logs too early.\n"
    "  2. GPIO interrupt failure: gpio171_interrupt_thread couldn't open GPIO file "
    "→ sends POWERMON_INTRPT_THREAD_CRASH. Falls back to direct polling.\n"
    "  3. Direct polling missed it: direct_poling_thread polls every ~30s. "
    "If relay was off briefly, the voltage change may have been missed.\n"
    "  4. power_monitor service not running: check systemd service status.\n"
    "  5. MSP/AON communication failure: APM logs 'read curr status callback failed' or "
    "'Unable to read current ign status' → ignition status never updated.\n"
    "  6. Debounce rejected the change: IGNS_worker reads 3 times at 50ms intervals. "
    "If readings don't all agree, the change is rejected.\n"
    "  7. Crank was already LOW: if crank was already LOW when check_uptime was called, "
    "this message IS logged. If crank NEVER went HIGH first, process_crank_high never ran, "
    "so check_uptime was never called in the CRANK_HIGH context.\n"
    "  8. SVC keepalive timeout: if power_monitor missed keepalive to SVC, "
    "SVC triggers system reboot before the log message could be written.\n"
    "  9. Supercap intervention: if supercap goes active (battery disconnect), "
    "power_monitor treats it as CRANK_LOW immediately, bypassing normal flow.\n\n"

    "LOG FORMAT:\n"
    "  - Device logs: epoch_ms: counter: SERVICE: LEVEL: message\n"
    "  - Processed logs: YYYY-MM-DD HH:MM:SS: epoch_ms: counter: SERVICE: LEVEL: message\n"
    "  - Levels: I=Info, E=Error, W=Warning, D=Debug, C=Critical\n\n"

    "COMMON FAILURE PATTERNS:\n"
    "  - 'Method not found' / 'Object not found': API object missing or method name typo in TC\n"
    "  - SSH connection failures: device unreachable, wrong credentials, network issues\n"
    "  - File not generated: timing issue — file check happens before device creates it\n"
    "  - OTA failures: download interrupted, wrong version, otacheck_count.txt issues\n"
    "  - Assertion on file counts: ND_INPUT file generation timing varies\n"
    "  - Validate_data exit: condition evaluated to false → fail_method action='exit'\n"
    "  - use_result() returning empty: previous step didn't save result or failed\n"
    "  - Log message not found (search_logs fails): this means the DEVICE BEHAVIOR didn't happen, "
    "NOT that the test is wrong. Ask WHY the device didn't produce that log message. Possible reasons:\n"
    "    * Hardware issue: relay didn't actually cut power, ignition signal not reaching device\n"
    "    * Timing issue: log search happened before the device had time to process the event\n"
    "    * Service crash: the service (e.g. power_mon) crashed or wasn't running\n"
    "    * Configuration issue: device config doesn't match expected behavior\n"
    "    * Network/SSH issue: device disconnected before logging could happen\n"
    "    * Firmware bug: the feature being tested has a regression in this build\n"
    "    * Wrong log file: the message might be in a different service log\n\n"

    "ANALYSIS RULES:\n"
    "(1) Be specific — cite exact log lines, timestamps, error messages.\n"
    "(2) Map test step failures back to the dict_list STEP structure.\n"
    "(3) When you see 'STEP_N_status == Fail', trace which API method was called and why it returned Fail.\n"
    "(4) Check if use_result() references have valid data from prior steps.\n"
    "(5) Do NOT give generic advice like 'check the logs' or 'verify the method'.\n"
    "(6) If data is missing, say so explicitly.\n"
    "(7) CRITICAL: When a log search fails (search_logs returns Fail), do NOT just say "
    "'the message was not found'. Instead, reason about WHY the device did not produce that "
    "message using the IGNITION EVENT FLOW above. Trace through the full chain: "
    "relay → MSP/AON → APM → sysfs → power_monitor → check_uptime. "
    "Identify which step in this chain likely failed.\n"
    "(8) CORRELATE automation steps with device logs: for each automation step, explain what "
    "SHOULD have happened inside the device services and what the device logs actually show. "
    "Example: 'After S1 (relay off), the device logs should show APM detecting IGNITION_OFF, "
    "power_monitor receiving POWERMON_CRANK_CHANGE with CRANK_LOW, and process_crank_low() "
    "initiating shutdown. Instead, the logs show...'\n"
    "(9) When relay steps are involved, trace the FULL ignition event flow from the "
    "nd_device_services firmware perspective: physical relay → MSP/AON detection → "
    "APM IGNS_worker → sysfs write → power_monitor GPIO/poll → process_crank_low/high.\n"
    "(10) Look for service-specific error patterns in device logs: "
    "'CRANK_ERROR' (GPIO read failure), 'registercallback failed' (APM interrupt setup failed), "
    "'Keep alive timeout' (SVC detected dead service), 'unable to read file in crank_level' "
    "(GPIO file inaccessible), 'write to sysfs failed' (APM couldn't update ignition status).\n"
    "(11) Output should include a section mapping automation steps to device behavior: "
    "for each key step, show what the automation did and what the device services did internally."
)

AI_USER_TEMPLATE = """A test case FAILED. Analyze the data below and determine the root cause.

IMPORTANT INSTRUCTIONS:
1. Do NOT just state what failed (e.g. "log message not found"). Reason about WHY using your knowledge
   of the nd_device_services firmware (power_monitor, APM, SVC, nd_central, etc.).
2. For EACH automation step, explain what should have happened inside the device services AND what
   the device logs actually show happened.
3. Trace the full event chain through the firmware: relay → MSP/AON → APM → sysfs → power_monitor.
4. If a search_logs step fails, use the IGNITION EVENT FLOW to identify which step in the
   firmware chain broke.

FAILED STEP:
{failed_step}

TEST STEPS (execution sequence):
{test_steps}

AUTOMATION LOGS (stderr/stdout from test runner):
{automation_logs}

DEVICE LOGS (from the dashcam device around the time of failure):
{device_logs}

TEST SOURCE CODE:
{test_code}

---
Respond with this structure:

## Root Cause
Identify the exact failure reason at the device/firmware level. Reference the specific firmware service
and function where the failure occurred (e.g. "power_monitor's check_uptime() was never called because
APM's IGNS_worker failed to detect the ignition change"). Quote specific log lines as evidence.

## Automation vs Device Correlation
For each key automation step, show:
- **Automation step**: What the test did (e.g. relay off, sleep 60s, search_logs)
- **Expected device behavior**: What should have happened in the firmware services
- **Actual device behavior**: What the device logs show happened (or didn't happen)

## What Happened (Timeline)
Step-by-step breakdown tracing through the firmware event chain.

## Possible Causes (Ranked)
1. **[High]** ... (cite specific firmware service/function)
2. **[Medium]** ...
3. **[Low]** ...

## Suggested Fixes
Actionable recommendations referencing specific firmware behaviors (e.g. check if APM motion_detection
is enabled adding 180s delay, increase sleep time in test, verify GPIO file readability).

## Confidence: High / Medium / Low
Explain why.
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
    MAX_SECTION = 3000 if "3b" in (payload.model or OLLAMA_MODEL) else 5000
    for field_name in ("automation_logs", "device_logs", "test_code"):
        val = getattr(payload, field_name, "")
        if len(val) > MAX_SECTION:
            truncated = val[:MAX_SECTION] + f"\n... (truncated, {len(val)} chars total)"
            user_prompt = user_prompt.replace(val, truncated)

    # Context size: keep small for fast prompt processing on CPU
    ctx_size = 4096 if "3b" in (payload.model or OLLAMA_MODEL) else 8192
    max_tokens = 2048 if "3b" in (payload.model or OLLAMA_MODEL) else 4096
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

DEEP_MAP_PROMPT = """You are analyzing a CHUNK of data from a failed Netradyne dashcam test case (nd_test_bot framework).
Summarize ONLY what is relevant to the failure. Focus on:
- Errors, exceptions, unexpected values
- State changes (values going from expected to unexpected)
- Timing anomalies (long gaps between events, timeouts)
- STEP_N_status values and which API methods were called
- SSH connection issues, file generation failures
- use_result() references that may have empty/wrong data
- Relay state changes and whether the device responded correctly to ignition events
- Log search results — if a search_logs step failed, note what message was expected and in which service log
- Any line that looks abnormal even if not flagged as error
- Signs of service crashes, restarts, or missing services in device logs

IMPORTANT: When you see a log search failure, don't just say "message not found". Note:
- What message was being searched for and in which log file
- What the message would indicate about device behavior (e.g. "low crank level" means device detected ignition off)
- Any log entries that show the device was in a DIFFERENT state than expected

Be concise. Output a bullet-point summary of findings. If nothing relevant, say "No relevant findings in this chunk."
"""

DEEP_REDUCE_PROMPT = """You are a senior QA engineer at Netradyne with deep knowledge of the nd_test_bot Test Automation Framework
AND the nd_device_services firmware (C++ services running on the dashcam device).

You understand the complete firmware architecture:
- power_monitor [PWR]: monitors crank voltage via GPIO, manages shutdown/suspend. check_uptime() logs
  "low crank level; check_uptime is deactivated" when crank != CRANK_HIGH.
- APM [APM]: Advanced Power Management with IGNS_worker (ignition interrupt with debounce), writes to sysfs.
  If apm_motion_detection enabled, waits 180s before writing IGNITION_OFF.
- SVC [SVC]: Service supervisor, receives keepalive from all services, kicks hardware watchdog.
- nd_central/bagheera [NDC]: Main recording service, switches processing_mode on ignition changes.
- circular_buffer [CB]: SD card management and file lifecycle.
- End-to-end ignition flow: relay → MSP/AON → APM IGNS_worker → sysfs → power_monitor GPIO/poll → process_crank_low/high

Multiple chunks of data from a failed test case have been analyzed independently.
Below are the summaries from each chunk, plus the test steps and failed step info.

YOUR TASK: Synthesize all chunk summaries into a final root cause analysis.
For EACH automation step, correlate with what the device firmware should have done internally.
When a log search fails, trace through the full ignition event chain to identify where it broke.

FAILED STEP:
{failed_step}

TEST STEPS:
{test_steps}

--- CHUNK SUMMARIES ---
{chunk_summaries}

---
Respond with this structure:

## Root Cause
Identify the exact failure at the firmware service level. Reference specific functions like
process_crank_low(), check_uptime(), ignition_cb_func(), etc. DO NOT just say "message not found".

## Automation vs Device Correlation
For each key automation step, show:
- **Automation step**: What the test did
- **Expected device behavior**: What the firmware services should have done
- **Actual device behavior**: What the device logs/chunk summaries show

## What Happened (Timeline)
Trace through the firmware event chain: relay → MSP/AON → APM → sysfs → power_monitor.

## Possible Causes (Ranked)
1. **[High]** ... (cite specific firmware service/function/config)
2. **[Medium]** ...
3. **[Low]** ...

## Suggested Fixes
Actionable recommendations referencing firmware behaviors and configs.

## Confidence: High / Medium / Low
Explain why.
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
    ctx_size = 4096 if "3b" in model else 8192
    # Much larger chunks to keep total manageable (target 8-12 chunks max)
    MAX_CHUNKS_PER_SECTION = 4   # max chunks per data section
    MAX_TOTAL_CHUNKS = 12        # absolute cap
    CHUNK_SIZE = 6000 if "3b" in model else 10000  # chars per chunk

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
                            "num_predict": 4096 if "7b" in model else 2048,
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
