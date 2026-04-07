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

from dotenv import load_dotenv
load_dotenv()  # Load .env file (JENKINS_USER, JENKINS_TOKEN, etc.)

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
    except SystemExit as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:
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

    # Fetch & parse every build
    build_results: list[pd.DataFrame] = []
    for build_num in builds:
        try:
            js = fetch_report_js(build_num, session, use_cache=True)
        except (SystemExit, Exception) as exc:
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

    # 1. Fetch scr.js
    try:
        js = fetch_report_js(build, session, use_cache=True)
    except Exception as exc:
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

    try:
        resp = session.get(log_url, timeout=120, allow_redirects=False)
        if resp.is_redirect:
            location = resp.headers.get("Location", "")
            if "commenceLogin" in location or "securityRealm" in location:
                log_error = "Jenkins authentication failed — the API token may have expired. Please update JENKINS_TOKEN in .env."
            else:
                log_error = f"Log request was redirected (HTTP {resp.status_code})"
        elif resp.status_code != 200:
            log_error = f"Log file not found (HTTP {resp.status_code})"
        else:
            all_lines = resp.text.split('\n')
            total_log_lines = len(all_lines)

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
                        log_lines.append(line)
            else:
                log_lines = all_lines[:500]
                log_error = "Could not parse start/end timestamps; showing first 500 lines."
    except Exception as exc:
        log_error = f"Failed to fetch log: {exc}"

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
            env["PATH"] = ":".join(
                p for p in (extra_paths + current_paths) if p and p not in current_paths[1:]
            )
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
