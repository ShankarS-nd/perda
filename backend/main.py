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
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/scripts")
async def get_scripts():
    """Return every discoverable script together with its expected arguments."""
    return list_scripts()


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

    try:
        rc1_js = fetch_report_js(payload.rc1.strip(), session)
        rc2_js = fetch_report_js(payload.rc2.strip(), session)
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

    return {
        "platform": platform,
        "rc1": payload.rc1.strip(),
        "rc2": payload.rc2.strip(),
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
        "graphs": {
            "known": known_graph,
            "unknown": unknown_graph,
        },
    }
