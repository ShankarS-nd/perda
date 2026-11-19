#!/usr/bin/env python3
"""
tc_worker.py - runs the dashboard's Claude jobs on this workstation.

The Release Tickets page queues a job (generate / validate / include) on the perda
backend. This worker claims it and runs the bug-regression skill through the
claude CLI, here, with your claude login and your bug-regression project folder:

    claude -p "/bug-regression:bug-regression dashboard-stage ..." --plugin-dir <skill>

It sends the log back as it goes, checks the result on disk (files exist, the branch
is really on origin) and reports it. Nothing else runs the job: no claude, no result.

Run it (standard library only, any Python 3.9+):

    export TC_WORKER_TOKEN=<same value as on the backend>
    python3 tools/tc_worker.py --project-root ~/Documents/TA_Utility

Options can also come from the environment: PERDA_API_URL, TC_WORKER_TOKEN,
BUGREG_PROJECT_ROOT, BUGREG_SKILL_DIR.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Any

DEFAULT_SERVER = "http://172.16.23.15:8000"
DEFAULT_SKILL_DIR = Path(__file__).resolve().parent.parent / ".claude" / "skills" / "bug-regression"
SKILL_COMMAND = "/bug-regression:bug-regression"
SKILL_MARKER = "Dashboard-driven stages"    # the SKILL.md section these jobs rely on
INCLUDE_INTO_MARKER = "Include into the given branch"    # the section that lets the skill push into an existing branch
PROTECTED_BRANCHES = ("main", "master")
REGEN_MARKER = "Regenerate after merge"     # the extra section the regenerate stage relies on
POLL_SEC = 5
# After claude reports it is finished, how long it may keep running (a background task it started
# may still hold the process open) before the worker closes it. The result file is already written.
PREFLIGHT = os.environ.get("TC_WORKER_PREFLIGHT", "1") != "0"    # check devices before a validate job
LINGER_SEC = int(os.environ.get("TC_WORKER_LINGER_SEC", "45"))
FLUSH_SEC = 3
STAGE_TIMEOUT_MIN = {"generate": 90, "validate": 300, "include": 45, "regenerate": 90, "remove": 10}

DT_RE = re.compile(r"^(DT|OCTO)-\d{1,7}$")
DEVICE_RE = re.compile(r"^[A-Za-z0-9]{6,24}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$")
JOB_RE = re.compile(r"^[0-9a-f]{32}$")


def valid_branch(name: str) -> bool:
    return bool(BRANCH_RE.fullmatch(name) and ".." not in name and "//" not in name
                and not name.endswith(("/", ".", ".lock")))


# ---------------------------------------------------------------------------
# Talking to the backend
# ---------------------------------------------------------------------------

class Api:
    def __init__(self, server: str, token: str, worker: str):
        self.server, self.token, self.worker = server.rstrip("/"), token, worker

    def post(self, path: str, body: dict[str, Any], timeout: int = 30) -> dict[str, Any]:
        req = urllib.request.Request(
            self.server + path, data=json.dumps({**body, "worker": self.worker}).encode(),
            headers={"Content-Type": "application/json", "X-Worker-Token": self.token}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read() or b"{}")


# ---------------------------------------------------------------------------
# Checks on disk: is the stage before this one really complete?
# ---------------------------------------------------------------------------

def candidates(root: Path, dt: str) -> list[Path]:
    return sorted((root / "out" / dt).glob("TC_*.py"))


def has_device_validation(root: Path, dt: str) -> bool:
    try:
        data = json.loads((root / "out" / dt / "bug_analysis.json").read_text())
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and bool(data.get("device_validation"))


REASON_CATEGORIES = ("testcase", "device", "environment", "product")


def correction_report(root: Path, dt: str, result: dict[str, Any], outcome: str,
                      before: dict[str, str] | None) -> dict[str, Any]:
    """What happened to the testcases during a validate run, from the files and from Claude's own words.
    `changed_files` is what the files say; `corrections` is what Claude says it changed and why."""
    after = snapshot(root, dt)
    prior = before or {}
    changed = sorted(n for n in after if n in prior and after[n] != prior[n])
    renamed = sorted(n for n in after if n not in prior) if prior else []
    corrections = []
    for c in (result.get("corrections") if isinstance(result.get("corrections"), list) else [])[:12]:
        if isinstance(c, dict):
            corrections.append({k: " ".join(str(c.get(k) or "").split())[:400] for k in ("testcase", "what", "why")})
    cat = str(result.get("reason_category") or "").lower()
    return {
        "changed_files": changed,
        "new_files": renamed,
        "corrections": corrections,
        "reason": " ".join(str(result.get("reason") or "").split())[:800],
        "reason_category": cat if cat in REASON_CATEGORIES else "",
    }


def validate_mode(params: dict[str, Any]) -> str:
    mode = params.get("mode")
    if mode in ("fixed", "unfixed", "both"):
        return mode
    return "both" if params.get("device_id") and params.get("unfixed_device_id") else "fixed"


def file_shas(root: Path, dt: str) -> dict[str, str]:
    """{testcase file name: hash of what it contains}. Evidence follows the content: the Jira TC id renames
    a file without changing it, an edit makes it a different testcase."""
    return {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in candidates(root, dt)}


def _state_path(root: Path, dt: str) -> Path:
    return root / "out" / dt / ".dashboard" / "validation_state.json"


def _tc_id(name: str) -> str:
    m = re.match(r"(TC_\d+)", name)
    return m.group(1) if m else name


def read_state(root: Path, dt: str) -> dict[str, dict[str, Any]]:
    """What has been shown for each testcase as it is now: {file name: {fixed, unfixed, fixed_result, unfixed_result}}.
    `fixed` is set once it passed on a device with the fix, `unfixed` once it failed, as it should, on a device
    without it. Evidence for older content of a file does not count."""
    shas = file_shas(root, dt)
    try:
        data = json.loads(_state_path(root, dt).read_text())
    except (OSError, ValueError):
        data = {}
    data = data if isinstance(data, dict) else {}
    by = data.get("by_sha") if isinstance(data.get("by_sha"), dict) else {}
    if not by and data.get("sha") and len(shas) == 1:        # the older ticket-wide file: only safe for one testcase
        h = next(iter(shas.values()))
        if data["sha"] == hashlib.sha256(h.encode()).hexdigest():
            by = {h: {"fixed": data.get("fixed"), "unfixed": data.get("unfixed"),
                      "fixed_result": "pass" if data.get("fixed") else "", "unfixed_result": "fail" if data.get("unfixed") else ""}}
    out = {}
    for name, sha in shas.items():
        e = by.get(sha) if isinstance(by.get(sha), dict) else {}
        out[name] = {"fixed": e.get("fixed") or None, "unfixed": e.get("unfixed") or None,
                     "fixed_result": e.get("fixed_result") or "", "unfixed_result": e.get("unfixed_result") or ""}
    return out


def run_sides(params: dict[str, Any], result: dict[str, Any], outcome: str) -> tuple[str, str]:
    """(fixed, unfixed) result of THIS run as a whole: pass | fail | na, or "" when that device was not used.
    `unfixed` fail is the good case: the bug showed up where the fix is missing."""
    mode = validate_mode(params)
    pick = lambda k: str(result.get(k) or "").lower() if str(result.get(k) or "").lower() in ("pass", "fail", "na") else ""  # noqa: E731
    fixed = pick("fixed_result") if mode in ("fixed", "both") else ""
    unfixed = pick("unfixed_result") if mode in ("unfixed", "both") else ""
    if mode in ("fixed", "both") and not fixed:       # older result shape: read it off the outcome
        fixed = {"yes": "pass", "partial": "pass", "no": "fail"}.get(outcome, "na")
    if mode in ("unfixed", "both") and not unfixed:
        unfixed = "fail" if (mode == "both" and outcome == "yes") else "na"
    return fixed, unfixed


def testcase_sides(params: dict[str, Any], result: dict[str, Any], outcome: str, names: list[str]) -> dict[str, tuple[str, str]]:
    """What THIS run showed for each testcase: pass | fail | na per device used, "" for a device not used or a
    testcase not run. Claude reports `testcase_results` per file; without it every testcase the run lists
    (or all of them) gets the run-wide result."""
    mode = validate_mode(params)
    wide_f, wide_u = run_sides(params, result, outcome)
    run_conclusive = result.get("unfixed_conclusive")
    if wide_u == "fail" and run_conclusive in (False, "false", "no"):
        wide_u = "na"                              # Claude says it failed for another reason: it proves nothing
    norm = lambda v: str(v or "").lower() if str(v or "").lower() in ("pass", "fail", "na") else ""  # noqa: E731
    listed = result.get("testcase_results") if isinstance(result.get("testcase_results"), list) else []
    reported: dict[str, tuple[str, str]] = {}
    for e in listed:
        if isinstance(e, dict) and e.get("testcase"):
            f = norm(e.get("fixed_result")) if mode in ("fixed", "both") else ""
            u = norm(e.get("unfixed_result")) if mode in ("unfixed", "both") else ""
            conclusive = e.get("unfixed_conclusive")
            if conclusive is None:                 # not said for this testcase: the run-wide answer, else trust the failure
                conclusive = result.get("unfixed_conclusive", True)
            if u == "fail" and conclusive in (False, "false", "no"):
                u = "na"                           # failed, but not for the reason the fix addresses: proves nothing
            for n in names:
                if n == str(e["testcase"]) or _tc_id(n) == _tc_id(str(e["testcase"])):
                    reported[n] = (f, u)
    ran = {str(t) for t in (result.get("testcases") or [])}
    ran_ids = {_tc_id(r) for r in ran}
    out = {}
    for n in names:
        if n in reported:
            out[n] = reported[n]
        elif ran and not (n in ran or _tc_id(n) in ran_ids):
            out[n] = ("", "")                      # the run did not list it: it was not run
        else:
            out[n] = (wide_f, wide_u)
    return out


def apply_sides(old: dict[str, dict[str, Any]], params: dict[str, Any], job_id: str,
                sides: dict[str, tuple[str, str]]) -> dict[str, dict[str, Any]]:
    new = {n: dict(e) for n, e in old.items()}
    for n, (fixed, unfixed) in sides.items():
        e = new.setdefault(n, {"fixed": None, "unfixed": None, "fixed_result": "", "unfixed_result": ""})
        if fixed == "pass":
            e["fixed"], e["fixed_result"] = {"device": params.get("device_id", ""), "job": job_id}, "pass"
        elif fixed in ("fail", "na"):
            e["fixed_result"] = fixed
            if fixed == "fail":
                e["fixed"] = None
        if unfixed == "fail":
            e["unfixed"], e["unfixed_result"] = {"device": params.get("unfixed_device_id", ""), "job": job_id}, "fail"
        elif unfixed in ("pass", "na"):
            e["unfixed_result"] = unfixed
            if unfixed == "pass":
                e["unfixed"] = None
    return new


def testcase_status(e: dict[str, Any]) -> str:
    """yes (both halves) | failed | partial (one half) | na | not_run."""
    if e.get("fixed") and e.get("unfixed"):
        return "yes"
    if e.get("fixed_result") == "fail":
        return "failed"
    if e.get("fixed") or e.get("unfixed"):
        return "partial"
    if "na" in (e.get("fixed_result"), e.get("unfixed_result")):
        return "na"
    return "not_run"


def validation_view(root: Path, dt: str) -> dict[str, dict[str, str]]:
    """Per testcase, for the page: its status and the devices that gave the evidence."""
    return {n: {"status": testcase_status(e), "fixed_device": (e.get("fixed") or {}).get("device", ""),
                "unfixed_device": (e.get("unfixed") or {}).get("device", "")}
            for n, e in read_state(root, dt).items()}


OUTCOME_RANK = {"no": 0, "inconclusive": 0, "partial": 1, "yes": 2}


def judge_validation(root: Path, job: dict[str, Any], result: dict[str, Any], outcome: str) -> tuple[str, dict[str, Any]]:
    """The outcome the evidence supports, and what this run showed. Yes needs EVERY testcase to have both
    halves for its current content, even when they came from separate runs."""
    params, dt = job.get("params") or {}, job["dt"]
    mode = validate_mode(params)
    names = sorted(file_shas(root, dt))
    sides = testcase_sides(params, result, outcome, names)
    # A failure that Claude traced to the device or its environment (no camera hub attached, a service not set up)
    # says nothing about the testcase: it is "not applicable here", never "failed".
    env_fail = outcome == "no" and result.get("reason_category") in ("device", "environment")
    if env_fail:
        sides = {n: ("na" if f == "fail" else f, u) for n, (f, u) in sides.items()}
    new = apply_sides(read_state(root, dt), params, str(job.get("id", "")), sides)
    status = {n: testcase_status(new[n]) for n in names if n in new}
    if any(f == "fail" for f, _ in sides.values()):
        computed = "no"
    elif status and all(v == "yes" for v in status.values()):
        computed = "yes"
    elif any(v in ("yes", "partial") for v in status.values()):
        computed = "partial"
    else:
        computed = "inconclusive" if mode == "unfixed" else ""
    if mode == "unfixed":
        final = computed or "inconclusive"
    elif computed:
        final = min(outcome, computed, key=lambda o: OUTCOME_RANK[o])   # never above what Claude found
        if computed == "yes" and outcome == "partial" and result.get("reason_category") in ("device", "environment", None, ""):
            final = "yes"      # Claude only saw its own half-run; both halves are on record for every testcase
    else:
        final = outcome
    fixed, unfixed = run_sides(params, result, outcome)
    if env_fail:
        final = "inconclusive"
        fixed = "na" if fixed == "fail" else fixed
    return final, {"fixed_result": fixed, "unfixed_result": unfixed,
                   "state": {"fixed": bool(new) and all(e.get("fixed") for e in new.values()),
                             "unfixed": bool(new) and all(e.get("unfixed") for e in new.values())},
                   "testcase_status": status,
                   "testcase_have": {n: {"fixed": bool(e.get("fixed")), "unfixed": bool(e.get("unfixed"))} for n, e in new.items()},
                   "testcase_sides": {n: {"fixed": f, "unfixed": u} for n, (f, u) in sides.items()}}


def commit_validation_state(root: Path, job: dict[str, Any], result: dict[str, Any]) -> None:
    params = job.get("params") or {}
    sides = {n: (v.get("fixed", ""), v.get("unfixed", "")) for n, v in (result.get("testcase_sides") or {}).items()}
    new = apply_sides(read_state(root, job["dt"]), params, str(job.get("id", "")), sides)
    shas = file_shas(root, job["dt"])
    path = _state_path(root, job["dt"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"by_sha": {shas[n]: e for n, e in new.items() if n in shas}}, indent=2) + "\n")


def remaining_items(root: Path, dt: str, params: dict[str, Any], result: dict[str, Any], outcome: str) -> list[str]:
    """What is still not validated after a validate run, as short plain lines.
    Worked out here from the files and the run's parameters; Claude may add its own lines
    under `remaining` (platforms not exercised, scenarios skipped at a gate, ...)."""
    items: list[str] = []
    env_stop = outcome == "inconclusive" and result.get("reason_category") in ("device", "environment")
    if (outcome in ("no", "partial") or env_stop) and result.get("reason"):
        cat = result.get("reason_category")
        items.append(f"Why: {'[' + cat + '] ' if cat else ''}{result['reason']}")
    elif outcome == "no":
        items.append("Claude gave no reason for the failure. Read the log before running it again.")
    if result.get("reason_category") == "testcase" and outcome == "no" and not result.get("changed_files"):
        items.append("Claude says the testcase is wrong but did not change it. Run Validate again so it can correct it.")
    if outcome == "no":
        items.append("The testcase failed on the fixed device: fix the testcase or the device state, then validate again.")
    state = result.get("state") or {}
    if outcome != "inconclusive" or state:
        if not state.get("unfixed"):
            if result.get("unfixed_result") == "pass":
                items.append("The testcase PASSED on the device meant to lack the fix, so the fail-without-the-fix run "
                             "is not confirmed (see Why). Use a device whose build really predates the fix.")
            else:
                items.append("Fail-without-the-fix run: not done. Validate again, choosing \"Device without the fix\", "
                             "with a device on a build from before the fix (this turns Partial into Yes).")
        if not state.get("fixed") and outcome != "no":
            items.append("Run on a device with the fix: not recorded for the testcases as they are now. Validate again, "
                         "choosing \"Device with the fix\".")
    status = result.get("testcase_status") or {}
    if len(status) > 1:
        say = {"failed": "failed on the device with the fix",
               "na": "reported NA on the device(s) tried (its own gate said not applicable): needs a suitable device",
               "not_run": "not run yet"}
        have = result.get("testcase_have") or {}
        for n, st in sorted(status.items()):
            if st == "yes":
                continue
            if st == "partial":
                text = ("passed with the fix; the fail-without-the-fix run is not shown" if have.get(n, {}).get("fixed")
                        else "fails without the fix as it should; the pass with the fix is not shown")
            else:
                text = say.get(st, st)
            items.append(f"{_tc_id(n)}: {text}.")
    extra = result.get("remaining")
    if isinstance(extra, list):
        for line in extra[:12]:
            text = " ".join(str(line).split())[:300]
            if text and text not in items:
                items.append(text)
    return items


def snapshot(root: Path, dt: str) -> dict[str, str]:
    """Fingerprint of every testcase file of a ticket, to tell whether a regenerate changed anything."""
    return {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in candidates(root, dt)}


def supersede_validation(root: Path, dt: str) -> str:
    """After an update, the old device run no longer describes the testcases: move it aside, never delete it."""
    path = root / "out" / dt / "bug_analysis.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return ""
    if not isinstance(data, dict) or not data.get("device_validation"):
        return ""
    old = data.pop("device_validation")
    data.setdefault("superseded_device_validation", []).append(old)
    path.write_text(json.dumps(data, indent=2) + "\n")
    return " The earlier device run is kept in bug_analysis.json as superseded_device_validation."


def backup_testcases(root: Path, dt: str, job_id: str) -> Path:
    """Copy of the ticket's testcase files, so a regenerate that does not finish leaves them as they were."""
    out = root / "out" / dt
    dest = out / ".dashboard" / f"{job_id}.before"
    dest.mkdir(parents=True, exist_ok=True)
    for f in [*out.glob("TC_*.py"), out / "bug_analysis.json"]:
        if f.is_file():
            shutil.copy2(f, dest / f.name)
    retired = out / "retired"
    (dest / "retired.txt").write_text("\n".join(sorted(p.name for p in retired.glob("*"))) if retired.is_dir() else "")
    return dest


def restore_testcases(root: Path, dt: str, backup: Path) -> None:
    out = root / "out" / dt
    for f in out.glob("TC_*.py"):
        f.unlink()
    for f in backup.glob("*"):
        if f.name == "retired.txt":
            continue
        shutil.copy2(f, out / f.name)
    retired = out / "retired"
    if retired.is_dir():
        keep = set((backup / "retired.txt").read_text().split("\n"))
        for f in retired.glob("*"):
            if f.name not in keep:
                f.unlink()


def _lines(value: Any, limit: int = 8) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if isinstance(value, dict):
        value = [f"{k}: {v}" for k, v in value.items()]
    if not isinstance(value, list):
        return []
    return [" ".join(str(v).split())[:400] for v in value[:limit] if str(v).strip()]


def _types(value: Any) -> list[str]:
    return [t.strip().lower() for t in _lines(value, 12) if t.strip()]


def requirements(root: Path, dt: str) -> dict[str, Any]:
    """What validating this ticket's testcases takes: platforms, devices, build. Read from the
    `validation_requirements` section of bug_analysis.json when Claude wrote one, else worked out
    as far as possible from the older, free-form sections."""
    try:
        data = json.loads((root / "out" / dt / "bug_analysis.json").read_text())
    except (OSError, ValueError):
        data = {}
    data = data if isinstance(data, dict) else {}
    vr = data.get("validation_requirements") if isinstance(data.get("validation_requirements"), dict) else {}
    fam = data.get("family_scope") if isinstance(data.get("family_scope"), dict) else {}
    dv = data.get("device_validation") if isinstance(data.get("device_validation"), dict) else {}
    runs_on = _types(vr.get("runs_on") or fam.get("covers"))
    na_on = _types(vr.get("na_on") or fam.get("na_on"))
    needs = _lines(vr.get("needs") or data.get("preconditions_for_validation"))
    if not vr and dv.get("needed"):
        needs += _lines(dv["needed"], 2)
    notes = _lines(vr.get("notes"))
    if not vr:
        for key in ("device_family", "platform_gating"):
            notes += _lines(data.get(key), 4)
    return {
        "runs_on": runs_on, "na_on": na_on, "needs": needs[:10], "notes": notes[:8],
        "fixed_build": " ".join(str(vr.get("fixed_build") or "").split())[:400],
        "unfixed_build": " ".join(str(vr.get("unfixed_build") or "").split())[:400],
        "testcases": [f.name for f in candidates(root, dt)],
        "pr_coverage": pr_coverage(root, dt),
        "pr_snapshot": pr_snapshot(root, dt)[0], "pr_snapshot_at": pr_snapshot(root, dt)[1],
        "device_checks": [{"what": c["what"], "fixed": c["fixed"], "unfixed": c["unfixed"]} for c in fix_checks(root, dt)],
        "validation": validation_view(root, dt),
    }


def valid_branch_name(name: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9._/\-]{1,200}", name)) and ".." not in name and not name.startswith("-")


def pr_snapshot(root: Path, dt: str) -> tuple[dict[str, str], str]:
    """Every PR linked to the ticket and its status when the evidence was last gathered
    (research_bundle.json), keyed `<repo><id>` like the page's PR list, plus when that was."""
    path = root / "out" / dt / "research_bundle.json"
    try:
        prs = json.loads(path.read_text()).get("dev_status_prs") or []
        at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(path.stat().st_mtime))
    except (OSError, ValueError, AttributeError):
        return {}, ""
    out = {}
    for p in prs[:40] if isinstance(prs, list) else []:
        if isinstance(p, dict) and p.get("id"):
            repo = str(p.get("repository") or "").split("/")[-1]
            out[f"{repo}{p['id']}"] = str(p.get("status") or "").upper()[:12]
    return out, at


def refresh_research(root: Path, skill_dir: Path, dt: str) -> bool:
    """Gather the ticket's evidence again (PR list and statuses, diffs) so a regenerate compares with today's
    state and the PR snapshot behind the page's "PRs changed" badge is current. Best effort."""
    py, script = root / ".venv" / "bin" / "python3", skill_dir / "scripts" / "bugreg_research.py"
    try:
        branch = str(json.loads((root / "out" / dt / "research_bundle.json").read_text()).get("target_branch") or "")
    except (OSError, ValueError):
        return False
    if not (py.exists() and script.exists() and branch and valid_branch_name(branch)):
        return False
    env = {**os.environ, "BUGREG_PROJECT_ROOT": str(root), "GIT_TERMINAL_PROMPT": "0"}
    try:
        r = subprocess.run([str(py), str(script), dt, "--branch", branch, "--refresh"], cwd=root, env=env,
                           capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
        return r.returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


PR_REF = re.compile(r"([\w.\-]+?)(?:#|/pull/|/)(\d+)\s*$")


def pr_coverage(root: Path, dt: str) -> dict[str, dict[str, Any]]:
    """Which linked PRs the testcases were built from. `pr_coverage` in bug_analysis.json is what Claude says
    (used: true/false and why); for a PR it did not list, the evidence bundle tells at least whether its diff
    was gathered (used true) or not (unknown: null)."""
    out: dict[str, dict[str, Any]] = {}
    try:
        raw = json.loads((root / "out" / dt / "bug_analysis.json").read_text()).get("pr_coverage")
    except (OSError, ValueError, AttributeError):
        raw = None
    for e in raw[:40] if isinstance(raw, list) else []:
        m = PR_REF.search(str(e.get("pr") or "")) if isinstance(e, dict) else None
        if m and isinstance(e.get("used"), bool):
            out[f"{m.group(1)}#{m.group(2)}"] = {"used": e["used"], "why": " ".join(str(e.get("why") or "").split())[:200], "by": "claude"}
    try:
        bundle = json.loads((root / "out" / dt / "research_bundle.json").read_text()).get("dev_status_prs") or []
    except (OSError, ValueError, AttributeError):
        bundle = []
    for p in bundle[:40] if isinstance(bundle, list) else []:
        if isinstance(p, dict) and p.get("id"):
            key = f"{str(p.get('repository') or '').split('/')[-1]}{p['id']}"
            if key not in out:
                has = bool(str(p.get("diff") or "").strip())
                out[key] = {"used": True if has else None,
                            "why": "its diff was gathered with the evidence" if has else "", "by": "bundle"}
    return out


def publish_requirements(api: "Api", root: Path) -> None:
    items = {}
    for d in sorted((root / "out").glob("*-*")):
        if DT_RE.fullmatch(d.name) and (d / "bug_analysis.json").is_file() and any(d.glob("TC_*.py")):
            items[d.name] = requirements(root, d.name)
    if items:
        try:
            api.post("/tc-worker/requirements", {"items": items})
        except (urllib.error.URLError, OSError):
            pass


LITERAL_SECRET = re.compile(r"""(?i)((?:password|passwd|pwd|token|secret)\w*\s*[:=]\s*)(['"])[^'"\n]{3,}\2""")


def publish_files(api: "Api", root: Path) -> None:
    """Send each ticket's testcase files so the page can open them. Hashes first; content only for
    the files the server does not have yet."""
    for d in sorted((root / "out").glob("*-*")):
        if not DT_RE.fullmatch(d.name):
            continue
        files = {f.name: f for f in d.glob("TC_*.py")}
        if not files:
            continue
        shas = {n: hashlib.sha256(f.read_bytes()).hexdigest() for n, f in files.items()}
        try:
            need = api.post("/tc-worker/files", {"dt": d.name, "shas": shas}).get("need") or []
            if need:
                send = [{"name": n, "content": LITERAL_SECRET.sub(r"\1\2***\2", files[n].read_text(errors="replace")[:200_000])}
                        for n in need if n in files]
                api.post("/tc-worker/files", {"dt": d.name, "shas": shas, "files": send})
        except (urllib.error.URLError, OSError):
            return


def wrong_platform(info: dict[str, Any], req: dict[str, Any], label: str, device_id: str) -> str | None:
    """A device of a platform the testcases are not applicable on would only report NA."""
    kind = str(info.get("device_type") or "").lower()
    if kind and kind in req.get("na_on", []):
        want = ", ".join(req.get("runs_on", [])) or "another platform"
        return (f"{label} {device_id} is a {kind}, and these testcases are not applicable on {kind} "
                f"(they would only report NA and prove nothing). Use a device of type: {want}.")
    return None


def revert_edits(root: Path, dt: str, backup: Path) -> list[str]:
    """Put back the content of testcase files Claude edited during a validate that did not end well.
    Only files that still exist under the same name are touched: a rename (the Jira TC id replacing a
    placeholder) is not undone, because the Jira ticket already carries the new name."""
    out = root / "out" / dt
    back = []
    for f in sorted(backup.glob("TC_*.py")):
        cur = out / f.name
        if cur.is_file() and cur.read_bytes() != f.read_bytes():
            shutil.copy2(f, cur)
            back.append(f.name)
    return back


def _run(cmd: list[str], timeout: int) -> tuple[int, str, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as exc:
        return 127, "", str(exc)


def check_device_info(info: dict[str, Any], device_id: str, label: str) -> str | None:
    """Why detect_device.py's answer rules a device out, or None. A tool that could not run is not a verdict."""
    error = str(info.get("error") or "")
    if error:
        if "pymongo not importable" in error:
            return None
        if "not found" in error:
            return (f"{label} {device_id} is not registered on this workstation (ip_db has no entry). Power it on "
                    f"on the lab network and let the framework hear it (auto_ip listens on UDP 12345), or check the ID.")
        return f"{label} {device_id} cannot be looked up: {error[:200]}"
    if not info.get("ssh_username"):
        return f"{label} {device_id} has an unrecognised type ({info.get('device_type')!r}); its SSH user cannot be derived."
    if not info.get("device_ip"):
        return f"{label} {device_id} has no IP in ip_db."
    return None


def check_ssh(returncode: int, stderr: str, label: str, device_id: str, user: str, ip: str) -> str | None:
    """Judge a login attempt made without credentials: all that matters is whether the host answers
    and presents the key we remember."""
    if "REMOTE HOST IDENTIFICATION HAS CHANGED" in stderr:
        return (f"{label} {device_id} ({ip}): the SSH host key is not the one saved in known_hosts. It may have been "
                f"reflashed, or another device now has that IP. Confirm it is the right device, then run "
                f"`ssh-keygen -R {ip}` and start again.")
    if returncode == 0 or "Permission denied" in stderr:
        return None
    if returncode == 124 or any(t in stderr for t in ("timed out", "No route to host", "Connection refused",
                                                       "Network is unreachable", "Could not resolve")):
        return f"{label} {device_id} is not reachable over SSH at {ip} ({_short(stderr, 120)})."
    return None   # anything else (an unknown host key, ...) is left for the run itself to deal with


READ_ONLY_WORDS = {"cat", "grep", "egrep", "zgrep", "ls", "stat", "md5sum", "sha256sum", "head", "tail", "wc",
                   "readlink", "uname", "which", "strings", "test", "echo"}
SYSTEMCTL_READ = {"is-active", "is-enabled", "status", "show", "cat", "list-unit-files"}
DPKG_READ = {"-l", "-s", "-L", "--list", "--status", "-W"}
CHECK_BAD = re.compile(r"[;&<>`\n\r]|\$\(")
EXPECT = ("match", "nomatch", "skip")


def safe_check_command(cmd: str) -> bool:
    """Only plain read-only commands, joined at most by pipes: no redirects, no `;`, `&`, backticks."""
    cmd = str(cmd or "").strip()
    if not cmd or len(cmd) > 300 or CHECK_BAD.search(cmd):
        return False
    for seg in cmd.split("|"):
        try:
            words = shlex.split(seg)
        except ValueError:
            return False
        if not words:
            return False
        w = words[0]
        if w == "systemctl":
            if not any(x in SYSTEMCTL_READ for x in words[1:2]):
                return False
        elif w == "dpkg":
            if words[1:2] and words[1] not in DPKG_READ:
                return False
        elif w not in READ_ONLY_WORDS:
            return False
    return True


def fix_checks(root: Path, dt: str) -> list[dict[str, str]]:
    """The device checks Claude wrote in bug_analysis.json (`validation_requirements.fix_checks`), cleaned.
    Each: what (plain words), command (read-only, run on the device), match (regex on its output), and what the
    output must do on the device WITH the fix (`fixed`) and WITHOUT it (`unfixed`): match | nomatch | skip."""
    try:
        data = json.loads((root / "out" / dt / "bug_analysis.json").read_text())
        raw = data["validation_requirements"]["fix_checks"]
    except (OSError, ValueError, KeyError, TypeError):
        return []
    out = []
    for c in raw[:12] if isinstance(raw, list) else []:
        if not isinstance(c, dict) or not safe_check_command(c.get("command")):
            continue
        if re.search(r"\bgrep\s+-\w*(r\w*c|c\w*r)", str(c.get("command"))) and "wc" not in str(c.get("command")):
            continue                              # `grep -rc` on a folder prints a line per file: its digits would match
        try:
            re.compile(str(c.get("match") or ""))
        except re.error:
            continue
        fx, un = str(c.get("fixed") or "skip").lower(), str(c.get("unfixed") or "skip").lower()
        out.append({"what": " ".join(str(c.get("what") or c["command"]).split())[:200], "command": str(c["command"]).strip(),
                    "match": str(c.get("match") or ""), "fixed": fx if fx in EXPECT else "skip",
                    "unfixed": un if un in EXPECT else "skip"})
    return out


def judge_checks(checks: list[dict[str, str]], side: str, results: list[dict[str, Any]], label: str,
                 device_id: str, req: dict[str, Any]) -> str | None:
    """Why the device is wrong for its role, or None. `side` is "fixed" or "unfixed"."""
    for c, r in zip(checks, results):
        want = c.get(side, "skip")
        if want == "skip":
            continue
        out = str(r.get("out") or "")
        found = bool(re.search(c["match"], out, re.M)) if c["match"] else r.get("rc") == 0
        if (want == "match") == found:
            continue
        seen = " ".join(out.split())[:160] or "(no output)"
        if side == "fixed":
            build = f" It needs: {req['fixed_build']}" if req.get("fixed_build") else ""
            return (f"{label} {device_id} does not have the fix: {c['what']}. Expected the check "
                    f"`{c['command']}` to {'match' if want == 'match' else 'not match'} `{c['match']}`; it gave: {seen}.{build}")
        build = f" It should be: {req['unfixed_build']}" if req.get("unfixed_build") else ""
        if want == "nomatch":
            return (f"{label} {device_id} already has the fix, so it cannot show the bug: {c['what']}. "
                    f"`{c['command']}` matched `{c['match']}` ({seen}).{build}")
        return (f"{label} {device_id} is not set up for this test: {c['what']}. Expected `{c['command']}` to match "
                f"`{c['match']}`; it gave: {seen}.{build}")
    return None


def run_device_checks(root: Path, info: dict[str, Any], password: str, checks: list[dict[str, str]]) -> dict[str, Any]:
    py, script = root / ".venv" / "bin" / "python3", Path(__file__).with_name("device_check.py")
    if not py.exists() or not script.exists():
        return {"error": "connect", "detail": "no project python or device_check.py"}
    env = {**os.environ, "BUGREG_CHECK_PASSWORD": password}
    try:
        r = subprocess.run([str(py), str(script)], input=json.dumps(
            {"host": info["device_ip"], "user": info["ssh_username"], "commands": [c["command"] for c in checks]}),
            capture_output=True, text=True, timeout=30 + 25 * len(checks), env=env)
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (subprocess.TimeoutExpired, OSError, ValueError, IndexError):
        return {"error": "connect", "detail": "the check did not finish"}


def device_state_problem(root: Path, info: dict[str, Any], password: str, side: str, label: str, device_id: str,
                         req: dict[str, Any], checks: list[dict[str, str]]) -> str | None:
    """Log in read-only and compare the device with what its role needs. A check that cannot run is not a verdict."""
    todo = [c for c in checks if c.get(side, "skip") != "skip"]
    if not todo:
        return None
    ans = run_device_checks(root, info, password, todo)
    if ans.get("error") == "login":
        return f"{label} {device_id} ({info['device_ip']}): the password was not accepted."
    if ans.get("error") or len(ans.get("results") or []) != len(todo):
        return None
    return judge_checks(todo, side, ans["results"], label, device_id, req)


def parse_device_info(out: str) -> dict[str, Any] | None:
    """detect_device.py prints ONE JSON object, indented over several lines (or one line on an error)."""
    for text in (out.strip(), (out.strip().splitlines() or [""])[-1]):
        try:
            info = json.loads(text)
        except ValueError:
            continue
        if isinstance(info, dict):
            return info
    return None


def preflight_device(root: Path, skill_dir: Path, device_id: str, label: str,
                     req: dict[str, Any] | None = None, side: str = "", password: str = "",
                     checks: list[dict[str, str]] | None = None) -> str | None:
    py, script = root / ".venv" / "bin" / "python3", skill_dir / "scripts" / "detect_device.py"
    if not py.exists() or not script.exists():
        return None
    _, out, _ = _run([str(py), str(script), device_id], 45)
    info = parse_device_info(out)
    if info is None:
        return None
    problem = check_device_info(info, device_id, label)
    if problem or info.get("error"):
        return problem
    problem = wrong_platform(info, req or {}, label, device_id)
    if problem:
        return problem
    user, ip = info["ssh_username"], info["device_ip"]
    rc, _, err = _run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "PreferredAuthentications=none",
                       "-o", "NumberOfPasswordPrompts=0", f"{user}@{ip}", "exit"], 30)
    problem = check_ssh(rc, err, label, device_id, user, ip)
    if problem or not (checks and side and password):
        return problem
    return device_state_problem(root, info, password, side, label, device_id, req or {}, checks)


def precheck(root: Path, job: dict[str, Any], skill_dir: Path | None = None) -> str | None:
    """Why this job cannot start, or None. The page's own gate is rechecked against real files."""
    dt, stage, params = job["dt"], job["stage"], job.get("params") or {}
    if not DT_RE.fullmatch(dt):
        return f"Not a DT/OCTO ticket key: {dt!r}"
    if stage == "generate":
        return None
    if not candidates(root, dt):
        return (f"Generated TCs is not complete on this workstation: no out/{dt}/TC_*.py in {root}. "
                f"Run Generated TCs first.")
    if stage == "regenerate":
        if not (root / "out" / dt / "bug_analysis.json").is_file():
            return f"out/{dt}/bug_analysis.json is missing, so there is no record of what the testcases were based on."
        if skill_dir is not None:
            try:
                if REGEN_MARKER not in (skill_dir / "SKILL.md").read_text():
                    return (f"The skill has no \"{REGEN_MARKER}\" section yet. Paste "
                            f"tools/SKILL_SECTION_12b_regenerate_after_merge.md into SKILL.md first.")
            except OSError:
                return f"No skill at {skill_dir}."
        return None
    if stage == "validate":
        for key in ("device_id", "unfixed_device_id"):
            if params.get(key) and not DEVICE_RE.fullmatch(params[key]):
                return f"Not a device id: {params[key]!r}"
        secrets = job.get("secrets") or {}
        if params.get("device_id") and not secrets.get("device_password"):
            return "The device password did not reach the worker. Start the validation again."
        if params.get("unfixed_device_id") and not secrets.get("unfixed_device_password"):
            return "The password of the device without the fix did not reach the worker. Start the validation again."
        if not params.get("device_id") and not params.get("unfixed_device_id"):
            return "No device was given."
        if skill_dir is not None and PREFLIGHT:
            # Cheap checks first: a wrong ID or a changed host key is found in seconds, before claude
            # runs, instead of after the run has started (and before any Jira ticket is created).
            req = requirements(root, dt)
            checks = [] if params.get("skip_device_checks") else fix_checks(root, dt)
            for key, label, side, pw in (("device_id", "Device", "fixed", "device_password"),
                                         ("unfixed_device_id", "Unfixed device", "unfixed", "unfixed_device_password")):
                if params.get(key):
                    problem = preflight_device(root, skill_dir, params[key], label, req, side, secrets.get(pw, ""), checks)
                    if problem:
                        return problem
        return None
    if stage == "include":
        if not valid_branch(params.get("branch", "")):
            return f"Not a branch name: {params.get('branch')!r}"
        custom = params.get("new_branch", "")
        if custom and params.get("target") != "existing":
            if not valid_branch(custom) or custom.removeprefix("origin/").lower() in PROTECTED_BRANCHES:
                return f"Not a usable name for the new branch: {custom!r}"
            repo = root / "repos" / "nd_test_bot"
            if repo.exists() and remote_sha(repo, custom):
                return f"A branch called {custom} already exists on the remote. Choose another name, or use \"Into this branch\" to add to it."
            if skill_dir is not None:
                try:
                    if "new-branch=<branch>" not in (skill_dir / "SKILL.md").read_text():
                        return "The skill has no `new-branch=<branch>` form in its include stage yet."
                except OSError:
                    return f"No skill at {skill_dir}."
        if params.get("target") == "existing":
            if params["branch"].removeprefix("origin/").lower() in PROTECTED_BRANCHES:
                return f"{params['branch']} is protected: the testcases are not pushed straight into it."
            if skill_dir is not None:
                try:
                    if INCLUDE_INTO_MARKER not in (skill_dir / "SKILL.md").read_text():
                        return (f"The skill has no \"{INCLUDE_INTO_MARKER}\" section yet, and its Include stage still "
                                f"forbids pushing into an existing branch. Paste tools/SKILL_SECTION_12d_include_into_branch.md "
                                f"into SKILL.md first.")
                except OSError:
                    return f"No skill at {skill_dir}."
        if not has_device_validation(root, dt):
            return (f"Validated in device is not complete on this workstation: out/{dt}/bug_analysis.json "
                    f"has no device_validation section. Run Validated in device first.")
        return None
    if stage == "remove":
        branch = params.get("branch", "")
        if not valid_branch(branch):
            return f"Not a branch name: {branch!r}"
        if branch.removeprefix("origin/").lower() in PROTECTED_BRANCHES:
            return f"{branch} is protected: testcases are not removed from it from here."
        if not (root / "repos" / "nd_test_bot" / ".git").exists():
            return f"No nd_test_bot checkout at {root / 'repos' / 'nd_test_bot'}."
        return None
    return f"Unknown stage: {stage}"


# ---------------------------------------------------------------------------
# The prompt: the skill, the stage, and where to write the result
# ---------------------------------------------------------------------------

def build_prompt(job: dict[str, Any], result_file: Path) -> str:
    dt, stage, p = job["dt"], job["stage"], job.get("params") or {}
    head = (f"{SKILL_COMMAND} dashboard-stage={stage} ticket={dt} job={job['id']} "
            f"result-file={result_file}")
    common = (
        "\n\nThis run was started from the perda dashboard (Release Tickets, Team status) by "
        f"{job.get('actor') or 'a dashboard user'}. Nobody is watching this session and nobody can answer "
        "a question, so never stop to ask one. Follow the skill's section \"Dashboard-driven stages\" "
        f"for the `{stage}` stage exactly, do only that stage, and finish by writing the result JSON it "
        "describes to the result file above. If you cannot complete the stage, write a result with "
        "outcome \"failed\" and the reason; do not guess and do not loosen a check to get a pass."
    )
    req_note = (
        "\n\nIn out/" + dt + "/bug_analysis.json also write a section `\"validation_requirements\"` so the dashboard can "
        "tell the user what to provide before validating: `{\"runs_on\": [device types the testcases run on, e.g. "
        "\"krait\", \"bagheera3\", \"octo\"], \"na_on\": [device types they report NA on], \"needs\": [plain lines, one "
        "per hardware or state requirement: SD card, paired motor, camera enabled, relay, ...], \"fixed_build\": \"what "
        "the build of the device WITH the fix must contain (PR, commit or release)\", \"unfixed_build\": \"what the "
        "device WITHOUT the fix must look like\", \"notes\": [anything else the user must know]}`. Use the exact "
        "device type names of the device registry (krait, krait2, bagheera, bagheera2, bagheera3, bagheera4, octo). "
        "Base it on the gates your testcases really have, not on guesses. ALSO add `\"fix_checks\"` to that section: a list "
        "of up to 8 checks the dashboard runs on each device BEFORE the test run, so a device without the fix (or without "
        "what the tests need) is rejected in seconds instead of after a long run. Each check: `{\"what\": \"plain "
        "words, e.g. the installed config has the new [health_central] section\", \"command\": \"ONE read-only shell "
        "command run on the device (cat, grep, ls, stat, md5sum, head, tail, wc, systemctl is-active/is-enabled, "
        "dpkg -s; pipes allowed; no redirects, no ;, no &, no sudo)\", \"match\": \"a regex searched in its output\", "
        "\"fixed\": \"match|nomatch|skip\", \"unfixed\": \"match|nomatch|skip\"}`. `fixed` / `unfixed` say what the "
        "output must do on the device WITH / WITHOUT the fix: `match` (regex found), `nomatch` (not found) or `skip`. "
        "The regex is searched in the WHOLE output, so the command must print one short line: count with `grep -c` on ONE "
        "file, or `grep -rl <string> <dir> | wc -l` for a folder. Never `grep -rc` on a folder (it prints a `path:count` "
        "line per file, and any digit in a file name matches `[1-9]`). Anchor the regex (`^[1-9]`, `^active$`). "
        "For EVERY hardware or state precondition your testcases rely on (an external camera hub attached, a feature or "
        "service enabled, a paired accessory) add a check that proves it on the device, for example that a log or a "
        "service state shows the feature is up, and never write in `needs` that hardware is not required unless you "
        "verified it. Use code the PR really changed (a config key or section it added, a string or md5 in a file it touched) so the "
        "check separates the two builds, plus what both devices need (a service that must be active: fixed `match` and "
        "unfixed `match`). Base each on what you verified in the diff and on a device if you had one; leave out a check you "
        "cannot make reliable.")
    pr_note = (
        "\n\nReading pull requests: `gh` is not installed and GITHUB_TOKEN is usually invalid, so the GitHub API often "
        "fails. That is NOT a reason to give up on a PR. Git over SSH works: in the PR's repo under repos/, run "
        "`git fetch origin refs/pull/<number>/head:refs/remotes/pr/<number>` (also `git fetch origin <base branch>`), "
        "then read it with `git diff $(git merge-base pr/<number> origin/<base branch>) pr/<number>` and "
        "`git log pr/<number>`. Whether a PR is merged: its head commit is an ancestor of the base branch on origin "
        "(`git merge-base --is-ancestor pr/<number> origin/<base branch>`). Read every linked PR this way before "
        "deciding the fix scope; only report `failed` for an unreadable PR if this also fails, and say what you tried.")
    req_note += (
        "\n\nALSO add `\"pr_coverage\"` to out/" + dt + "/bug_analysis.json: one entry for EVERY pull request linked to the "
        "ticket (open, merged, declined, other branches, reverts): `{\"pr\": \"<repo>#<number>\", \"used\": true|false, "
        "\"why\": \"short reason\"}`. `used` is true only when you read that PR's diff and the testcases cover its change. "
        "False when you could not read it, it is still open and unreadable, declined, a revert, for another branch, or "
        "unrelated to this behaviour; say which in `why`. The dashboard shows each PR as in or not in the testcases.")
    if stage == "generate":
        return head + common + req_note + pr_note
    if stage == "regenerate":
        return head + req_note + pr_note + common.replace(
            "for the `regenerate` stage", "(\"Regenerate after merge\") for the `regenerate` stage") + (
            "\n\nThe testcases already exist in out/" + dt + "/. Re-check them against the fix as it is now, "
            "change only what the merged code makes wrong or incomplete, and change nothing if they are still right. "
            "Do not touch a device, any repo or Jira.")
    if stage == "validate":
        mode = validate_mode(p)
        extra, note = "", ""
        if p.get("device_id"):
            extra += f" device={p['device_id']}"
            note += ("\n\nThe password of the device WITH the fix is in the environment variable BUGREG_DEVICE_PASSWORD. "
                     "It is the current password, entered by the user for this run.")
        if p.get("unfixed_device_id"):
            extra += f" unfixed-device={p['unfixed_device_id']}"
            note += ("\n\nThe password of the device WITHOUT the fix is in BUGREG_UNFIXED_DEVICE_PASSWORD.")
        if mode == "fixed":
            note += (" No device without the fix is part of this run: skip the fail-without-the-fix run and do not "
                     "treat that as a gap of this run (the dashboard keeps track of it).")
        elif mode == "unfixed":
            note += ("\n\nTHIS RUN IS ONLY ON THE DEVICE WITHOUT THE FIX. There is no device with the fix in this run: do not "
                     "look for one and do not run on any other device. Do the normal setup (Jira TC ticket if missing, "
                     "deploy, run) and run the testcases on that one device. The testcases are EXPECTED TO FAIL there, at the "
                     "step that depends on the fix. Do not edit a testcase in this run: a pass on this device is evidence "
                     "about the device (it may have the fix) or about the testcase (it may not detect the bug), so report it.")
        note += ("\n\nIf a testcase does not pass on the device that has the fix, do not just report it. Work out why "
                 "from the framework log and the device before touching anything, then decide who is at fault:\n"
                 "- `testcase`: wrong oracle, wrong path or log line, timing, missing cleanup, a step that cannot work on this "
                 "device family. Correct the testcase IN PLACE (same file, same TC id), run validate_candidate.py, and run it on "
                 "the device again. At most 3 attempts. Never weaken an oracle, remove a check, or change what is expected "
                 "just to get a pass: if the behaviour on the fixed device is wrong, that is `product`, not `testcase`.\n"
                 "- `device`: the build lacks the fix, a capability or hardware is missing, the device state is wrong.\n"
                 "- `environment`: framework, network, gRPC, mongo, SSH or tooling trouble.\n"
                 "- `product`: the fix does not behave as the ticket says.\n"
                 "Only `testcase` is yours to fix. For the others change nothing, and say what the user must do. "
                 "If a copy of the testcase was already deployed or pushed to a branch, leave that copy alone and say so.\n"
                 "Add to the result file: `\"reason\"` (two or three plain sentences: what failed or is doubtful and why) and "
                 "`\"reason_category\"` (one of the four words above) whenever the outcome is `no` or `partial`, and "
                 "`\"corrections\": [{\"testcase\": \"<file>\", \"what\": \"<what you changed>\", \"why\": \"<why the old "
                 "version was wrong>\"}]` for every change you made to a testcase (an empty list if none).\n"
                 "When a device WITHOUT the fix is used, also add the run-wide `\"unfixed_conclusive\": true|false`: true only when the testcase(s) failed there at the step that checks the fix, because of the bug; false when it failed for another reason (service or binary missing, device not set up, wrong build). Never base it on the missing fixed-device run: a run without a fixed device says nothing about this flag. "
                 "Also report what happened on each device used in this run: `\"fixed_result\"` (device WITH the fix) and "
                 "`\"unfixed_result\"` (device WITHOUT the fix), each `\"pass\"`, `\"fail\"` or `\"na\"`. On the unfixed "
                 "device `\"fail\"` is the GOOD result: the testcase failed there because the bug is present. `\"pass\"` there "
                 "means the testcase does not detect the bug, or the device is not really unfixed (check its binary or build "
                 "and say which in `reason`). Leave out the key for a device that was not used.\n"
                 "When the ticket has more than one testcase file, ALSO add `\"testcase_results\": [{\"testcase\": \"<file name>\", "
                 "\"fixed_result\": \"pass|fail|na\", \"unfixed_result\": \"pass|fail|na\", \"unfixed_conclusive\": true|false}]`: one entry per testcase file you "
                 "ran or tried, with the keys of the devices used in this run only. `\"na\"` means the testcase's own gate said it "
                 "is not applicable on that device, so it proved nothing. `\"unfixed_conclusive\"` is true only when the testcase failed on the unfixed device at the step that checks the fix, "
                 "because of the bug; false when it failed for another reason (service or binary missing, device not set up, "
                 "wrong build), which proves nothing. Do not list a testcase you did not run. The dashboard shows "
                 "each testcase as fully validated, partially validated or not validated from these.")
        note += ("\n\nIn the result file, also add `\"remaining\": [...]`: short plain lines for anything about this "
                 "ticket that is still NOT validated after this run (a testcase or scenario that was skipped or "
                 "not applicable and why, device families or platforms not exercised, steps not verified). "
                 "An empty list means nothing is left. Do not repeat the missing unfixed-device run; the dashboard adds that.")
        return head + extra + common + note
    if p.get("target") == "existing":
        return (head + f" target-branch={p['branch']}" + common + (
            f"\n\nThe user chose to push the validated testcases INTO the existing branch `{p['branch']}` "
            "(confirmed in the dashboard), not to create a new branch. Follow the skill's section "
            "\"Include into the given branch\" exactly: plain push, never force, only the validated testcase "
            "files and their main_db.xlsx rows, from a separate worktree. Report `\"branch\"` (that same branch) and "
            "`\"commit\"` (the full sha you pushed)."))
    if p.get("new_branch"):
        return (head + f" base-branch={p['branch']} new-branch={p['new_branch']}" + common + (
            f"\n\nThe user chose the name of the new branch: `{p['new_branch']}`. Create exactly that branch from "
            f"`{p['branch']}` (the skill's `new-branch=` form of the include stage). If that name already exists on origin, "
            "do not add a suffix and do not push: report `failed` and say so. Report `\"branch\"` as that exact name and "
            "`\"commit\"` (the full sha you pushed)."))
    return head + f" base-branch={p['branch']}" + common


# ---------------------------------------------------------------------------
# Reading claude's stream-json output into log lines
# ---------------------------------------------------------------------------

def _short(text: str, n: int = 220) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def log_lines(raw: str) -> list[str]:
    """Turn one line of `claude --output-format stream-json` into readable log lines."""
    raw = raw.strip()
    if not raw:
        return []
    try:
        ev = json.loads(raw)
    except ValueError:
        return [raw]
    if not isinstance(ev, dict):
        return []
    kind = ev.get("type")
    if kind == "assistant":
        out = []
        for block in (ev.get("message") or {}).get("content") or []:
            if block.get("type") == "text" and block.get("text", "").strip():
                out.extend(block["text"].strip().splitlines())
            elif block.get("type") == "tool_use":
                inp = block.get("input") or {}
                what = inp.get("description") or inp.get("command") or inp.get("file_path") or inp.get("pattern") or inp.get("skill") or ""
                out.append(f"  > {block.get('name', 'tool')}: {_short(what)}")
        return out
    if kind == "result":
        tail = "finished" if ev.get("subtype") == "success" and not ev.get("is_error") else f"ended: {ev.get('subtype')}"
        return [f"[claude {tail}]"]
    return []


def scrub(text: str, secrets: list[str]) -> str:
    for s in secrets:
        if s:
            text = text.replace(s, "***")
    return text


# ---------------------------------------------------------------------------
# Checking what claude says it did
# ---------------------------------------------------------------------------

def read_result(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def remote_targets(repo: Path) -> list[str]:
    """Where to look for a pushed branch: the configured origin first, then its SSH form. The skill may
    push over SSH when the configured HTTPS origin has no credentials in a headless session."""
    targets = ["origin"]
    r = subprocess.run(["git", "remote", "get-url", "origin"], cwd=repo, capture_output=True, text=True, timeout=30)
    m = re.match(r"^https://([^/]+)/(.+?)(?:\.git)?/?$", r.stdout.strip())
    if m:
        targets.append(f"git@{m.group(1)}:{m.group(2)}.git")
    return targets


def remote_sha(repo: Path, branch: str) -> str:
    """Head commit of a branch on the remote (origin, then its SSH form), or "" when it is not there."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o ConnectTimeout=15"}
    for target in remote_targets(repo):
        try:
            r = subprocess.run(["git", "ls-remote", "--exit-code", "--heads", target, f"refs/heads/{branch}"],
                               cwd=repo, capture_output=True, text=True, timeout=60, env=env, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            continue
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.split()[0]
    return ""


ALLOWED_PUSH_PATHS = ("Test_Automation_Framework/src/test_cases/", "Test_Automation_Framework/main_db.xlsx")


def check_push_into(repo: Path, before: str, commit: str) -> str | None:
    """After a push into an existing branch: it moved forward from where it was, and only testcase files
    and main_db.xlsx changed. None when fine or when the local repo cannot tell; else what went wrong."""
    if not before or before.startswith(commit) or commit.startswith(before):
        return None
    def git(*a: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True, timeout=60)
    anc = git("merge-base", "--is-ancestor", before, commit)
    if anc.returncode == 1:
        return "The branch was not moved forward from where it was: its history was rewritten."
    if anc.returncode == 0:
        diff = git("diff", "--name-only", before, commit)
        if diff.returncode == 0:
            extra = [f for f in diff.stdout.split() if not f.startswith(ALLOWED_PUSH_PATHS[0]) and f != ALLOWED_PUSH_PATHS[1]]
            if extra:
                return f"The push also changed files that are not testcases: {', '.join(extra[:6])}."
    return None


def branch_on_origin(repo: Path, branch: str, commit: str = "") -> bool:
    """The branch really is on the remote (and at the commit Claude reported, when it reported one)."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o ConnectTimeout=15"}
    for target in remote_targets(repo):
        try:
            r = subprocess.run(["git", "ls-remote", "--exit-code", "--heads", target, f"refs/heads/{branch}"],
                               cwd=repo, capture_output=True, text=True, timeout=60, env=env, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            continue
        sha = r.stdout.split()[0] if r.returncode == 0 and r.stdout.strip() else ""
        if sha and (not re.fullmatch(r"[0-9a-f]{7,40}", commit or "") or sha.startswith(commit)):
            return True
    return False


def verify(root: Path, job: dict[str, Any], result: dict[str, Any],
           before: dict[str, str] | None = None) -> tuple[str, str, str, dict[str, Any]]:
    """(status, outcome, message, result) after checking the claimed result against reality."""
    dt, stage, params = job["dt"], job["stage"], job.get("params") or {}
    outcome = str(result.get("outcome") or "")
    summary = _short(result.get("summary") or "", 1500)
    if not result:
        return "failed", "", "Claude ended without writing a result, so the stage is not complete. See the log.", {}
    if outcome == "failed":
        return "failed", outcome, summary or "Claude reported that the stage could not be completed.", result

    if stage == "generate":
        if outcome in ("covered", "not_testable"):
            default = {"covered": "An existing testcase already covers this ticket.",
                       "not_testable": "This ticket cannot be turned into an automated regression test."}[outcome]
            return "done", outcome, summary or default, result
        files = [f.name for f in candidates(root, dt)]
        if outcome != "generated" or not files:
            return "failed", outcome, f"No testcase file was written to out/{dt}/. {summary}", result
        return "done", "generated", summary, {**result, "testcases": files}

    if stage == "regenerate":
        after = snapshot(root, dt)
        changed = sorted(n for n in {*after, *(before or {})} if after.get(n) != (before or {}).get(n))
        if outcome == "not_merged":
            if changed:
                return "failed", outcome, "Claude reported that nothing could be updated yet, but testcase files changed. They are put back as they were.", result
            return "done", outcome, summary or "The fix PRs are not merged yet, so nothing was changed.", {**result, "testcases": sorted(after)}
        if outcome not in ("updated", "unchanged"):
            return "failed", outcome, f"Unexpected regenerate outcome {outcome!r}. {summary}", result
        if not after:
            return "failed", outcome, "No testcase file is left in the ticket's folder, so the result is not trusted. The files are put back as they were.", result
        # The files decide, not what Claude says about them.
        note = ""
        if changed and outcome == "unchanged":
            note = "Testcase files changed although Claude reported none. "
        if not changed and outcome == "updated":
            note = "Claude reported an update but no testcase file changed. "
        final = "updated" if changed else "unchanged"
        return "done", final, (note + summary).strip(), {**result, "outcome": final, "testcases": sorted(after), "changed_files": changed}

    if stage == "validate":
        if outcome not in ("yes", "partial", "no", "inconclusive"):
            return "failed", outcome, f"Unexpected validation outcome {outcome!r}. {summary}", result
        if not has_device_validation(root, dt) and validate_mode(params) != "unfixed":
            return "failed", outcome, f"out/{dt}/bug_analysis.json has no device_validation section, so no run was recorded. {summary}", result
        final, sides = judge_validation(root, job, result, outcome)
        note = ""
        if final != outcome:
            note = {"inconclusive": "This run proved nothing by itself, so Validated is left as it was. ",
                    "partial": "Both halves are not shown yet for these testcases, so this is Partial. ",
                    "yes": "The fixed-device pass and the fail-without-the-fix are both on record for these testcases. ",
                    "no": "The testcase failed on the device with the fix. "}.get(final, "")
        outcome = final
        result = {**result, "outcome": outcome, **sides, **correction_report(root, dt, result, outcome, before)}
        return "done", outcome, (note + summary).strip(), {**result, "remaining": remaining_items(root, dt, params, result, outcome)}

    if stage == "include":
        branch, commit = str(result.get("branch") or ""), str(result.get("commit") or "")
        repo = root / "repos" / "nd_test_bot"
        if params.get("target") == "existing":
            if outcome != "pushed" or branch != params.get("branch"):
                return "failed", outcome, f"The testcases were not reported as pushed into {params.get('branch')}. {summary}", result
            if not re.fullmatch(r"[0-9a-f]{40}", commit):
                return "failed", outcome, f"No commit was reported for the push into {branch}, so it is not trusted. {summary}", result
            if not branch_on_origin(repo, branch, commit):
                return "failed", outcome, (f"{branch} on the remote is not at the commit that was reported ({commit[:9]}): the "
                                           f"push did not happen, or somebody pushed after it. {summary}"), result
            problem = check_push_into(repo, (before or {}).get("remote_sha", ""), commit)
            if problem:
                return "failed", outcome, f"{problem} The push to {branch} HAS happened: look at commit {commit[:9]}. {summary}", result
            return "done", "pushed", summary or f"Pushed into {branch} ({commit[:9]})", result
        if outcome != "pushed" or not valid_branch(branch):
            return "failed", outcome, f"No new branch was reported. {summary}", result
        if params.get("new_branch") and branch != params["new_branch"]:
            return "failed", outcome, f"The new branch was asked to be called {params['new_branch']} but {branch} was reported. {summary}", result
        if branch == params.get("branch"):
            return "failed", outcome, "The reported branch is the base branch itself; a new branch is required.", result
        if not branch_on_origin(repo, branch, commit):
            return "failed", outcome, f"Branch {branch} is not on origin, so the push did not happen. {summary}", result
        return "done", "pushed", summary or f"Pushed {branch}", result

    return "failed", outcome, f"Unknown stage {stage}", result


# ---------------------------------------------------------------------------
# Running one job
# ---------------------------------------------------------------------------

def descendants(pid: int) -> list[tuple[int, str]]:
    """(pid, command) of everything started under a process, including shells that left its session."""
    try:
        out = subprocess.run(["ps", "-eo", "pid=,ppid=,args="], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    kids: dict[int, list[tuple[int, str]]] = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            kids.setdefault(int(parts[1]), []).append((int(parts[0]), parts[2] if len(parts) > 2 else ""))
    found, stack = [], [pid]
    while stack:
        for child in kids.get(stack.pop(), []):
            found.append(child)
            stack.append(child[0])
    return found


def kill_group(proc: subprocess.Popen, tree: list[tuple[int, str]] | None = None) -> None:
    """Stop claude and its process group. `tree` also stops leftovers that left the group (taken
    before claude dies, because afterwards they are re-parented and cannot be found any more)."""
    for pid, _ in tree or []:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        pass
    for pid, _ in tree or []:
        try:
            os.kill(pid, 0)
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


DROP_ROWS = (
    "import sys, openpyxl\n"
    "path, names = sys.argv[1], set(sys.argv[2:])\n"
    "wb = openpyxl.load_workbook(path); ws = wb.active\n"
    "head = [c.value for c in next(ws.iter_rows(min_row=1, max_row=1))]\n"
    "col = head.index('file_name') + 1\n"
    "rows = [r for r in range(2, ws.max_row + 1) if ws.cell(r, col).value in names]\n"
    "for r in reversed(rows): ws.delete_rows(r)\n"
    "if rows: wb.save(path)\n"
    "print(len(rows))\n"
)


def ticket_testcase_names(root: Path, dt: str) -> list[str]:
    """Every file name the ticket's testcases have had: those on disk and those Jira renamed them to."""
    names = {f.name for f in candidates(root, dt)}
    try:
        data = json.loads((root / "out" / dt / "bug_analysis.json").read_text())
        for t in data.get("jira_tc_subtasks") or []:
            if isinstance(t, dict) and re.fullmatch(r"TC_[A-Za-z0-9_\-]+\.py", str(t.get("testcase_file") or "")):
                names.add(t["testcase_file"])
    except (OSError, ValueError, AttributeError):
        pass
    return sorted(names)


def remove_from_branch(root: Path, job: dict[str, Any], note: Callable[[str], None]) -> tuple[str, str, str, dict[str, Any]]:
    """Take a ticket's testcase files and their main_db.xlsx rows out of an existing branch with one new
    commit and a plain push. No model is involved and history is never rewritten, so it can be undone
    with a revert. Returns (status, outcome, message, result)."""
    dt, branch, jid = job["dt"], job["params"]["branch"], job["id"]
    repo = root / "repos" / "nd_test_bot"
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o ConnectTimeout=15"}

    def git(*a: str, cwd: Path = repo, timeout: int = 120) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env,
                              stdin=subprocess.DEVNULL)

    def fetch() -> tuple[str, str]:
        for target in remote_targets(repo):
            r = git("fetch", "--quiet", target, f"refs/heads/{branch}")
            if r.returncode == 0:
                return target, git("rev-parse", "FETCH_HEAD").stdout.strip()
        return "", ""

    names = ticket_testcase_names(root, dt)
    if not names:
        return "failed", "", f"No testcase of {dt} is known on this workstation, so there is nothing to look for on the branch.", {}
    note(f"Looking for {', '.join(names)} on {branch}")
    target, head = fetch()
    if not head:
        return "failed", "", f"Branch {branch} was not found on the remote.", {}
    wt = root / "out" / dt / ".dashboard" / f"wt_rm_{jid}"
    if git("worktree", "add", "--detach", str(wt), head).returncode != 0:
        return "failed", "", "Could not set up a separate work area for the removal.", {}
    try:
        base = wt / "Test_Automation_Framework"
        files = [f for n in names for f in sorted((base / "src" / "test_cases").glob(f"*/{n}"))]
        py = root / ".venv" / "bin" / "python3"
        rows = 0
        db = base / "main_db.xlsx"
        if db.is_file() and py.exists():
            rc, out, err = _run([str(py), "-c", DROP_ROWS, str(db), *names], 120)
            if rc != 0:
                return "failed", "", f"Could not edit main_db.xlsx: {_short(err, 200)}", {}
            rows = int(out.strip() or 0)
        if not files and not rows:
            return "done", "absent", f"None of {', '.join(names)} is on {branch}: nothing to remove.", {"branch": branch, "removed_files": [], "removed_rows": 0}
        for f in files:
            git("rm", "-q", "--", str(f.relative_to(wt)), cwd=wt)
        if rows:
            git("add", "--", "Test_Automation_Framework/main_db.xlsx", cwd=wt)
        status = git("status", "--porcelain", cwd=wt).stdout.splitlines()
        stray = [l for l in status if not (l[3:].startswith(ALLOWED_PUSH_PATHS[0]) or l[3:] == ALLOWED_PUSH_PATHS[1])]
        if stray or not status:
            return "failed", "", f"Unexpected changes in the work area, nothing was pushed: {'; '.join(stray[:4]) or 'no change'}", {}
        ids = ", ".join(sorted({re.match(r"(TC_\d+)", f.name).group(1) for f in files if re.match(r"TC_\d+", f.name)}))
        c = git("commit", "-q", "-m", f"{dt}: remove regression testcase(s) {ids}", cwd=wt)
        if c.returncode != 0:
            return "failed", "", f"Could not commit: {_short(c.stderr, 200)}", {}
        commit = git("rev-parse", "HEAD", cwd=wt).stdout.strip()
        pushed = False
        for attempt in (1, 2):
            note(f"Pushing to {branch}" + (" (again, after the branch moved)" if attempt == 2 else ""))
            for tgt in remote_targets(repo):
                if git("push", "--quiet", tgt, f"HEAD:refs/heads/{branch}", cwd=wt, timeout=180).returncode == 0:
                    pushed = True
                    break
            if pushed or attempt == 2:
                break
            target, head = fetch()                                 # the branch moved: rebase once, push again
            if not head or git("rebase", head, cwd=wt, timeout=180).returncode != 0:
                git("rebase", "--abort", cwd=wt)
                return "failed", "", f"{branch} moved and the removal could not be replayed on top of it. Nothing was pushed.", {}
            commit = git("rev-parse", "HEAD", cwd=wt).stdout.strip()
        if not pushed:
            return "failed", "", f"The push to {branch} was refused. Nothing was changed on the branch.", {}
        if not branch_on_origin(repo, branch, commit):
            return "failed", "", f"{branch} on the remote is not at the removal commit {commit[:9]}: somebody pushed after it, or the push did not happen.", {}
        problem = check_push_into(repo, head, commit)
        if problem:
            return "failed", "", f"{problem} The push to {branch} HAS happened: look at commit {commit[:9]}.", {}
        removed = sorted(str(f.relative_to(wt)) for f in files)
        return "done", "removed", (f"Removed {len(files)} testcase file(s) and {rows} main_db.xlsx row(s) from {branch} in commit {commit[:9]}. "
                                  f"Validated in device is unchanged."), {"branch": branch, "commit": commit, "removed_files": removed, "removed_rows": rows}
    finally:
        git("worktree", "remove", "--force", str(wt))


def run_job(api: Api, args: argparse.Namespace, job: dict[str, Any]) -> None:
    root: Path = args.project_root
    secrets = job.pop("secrets", None) or {}
    secret_values = [v for v in secrets.values() if v]
    job["secrets"] = secrets
    jid, dt, stage = job["id"], job["dt"], job["stage"]
    backup: Path | None = None
    print(f"[{time.strftime('%H:%M:%S')}] {dt} {stage} ({jid[:8]}) started", flush=True)

    def finish(status: str, outcome: str, message: str, result: dict[str, Any]) -> None:
        # A regenerate that did not finish must not leave testcases half-edited.
        if status != "done" and stage == "regenerate" and backup is not None:
            restore_testcases(root, dt, backup)
            message += " The testcase files are back as they were before this run."
        # A validate that did not end well must not leave testcase edits that were never proven on the device.
        if stage == "validate" and backup is not None and (status != "done" or outcome == "no"):
            back = revert_edits(root, dt, backup)
            if back:
                message += f" Claude's edits to {', '.join(back)} did not pass on the device and are undone."
                result = {**result, "reverted_files": back}
        message = scrub(message, secret_values)
        result = json.loads(scrub(json.dumps(result), secret_values))
        for attempt in range(6):
            try:
                api.post(f"/tc-worker/jobs/{jid}/finish",
                         {"status": status, "outcome": outcome, "message": message, "result": result})
                break
            except (urllib.error.URLError, OSError) as exc:
                if isinstance(exc, urllib.error.HTTPError) and exc.code < 500:
                    print(f"  backend refused the result: {exc.code} {exc.read()[:200]!r}", flush=True)
                    break
                time.sleep(5 * (attempt + 1))
        print(f"[{time.strftime('%H:%M:%S')}] {dt} {stage} -> {status} {outcome} {message[:160]}", flush=True)

    if not JOB_RE.fullmatch(jid):
        return finish("failed", "", "Bad job id.", {})
    problem = precheck(root, job, args.skill_dir)
    if problem:
        return finish("failed", "", problem, {})
    if stage == "remove":      # plain git work: no model is involved
        def note(text: str) -> None:
            try:
                api.post(f"/tc-worker/jobs/{jid}/progress", {"log": text + "\n"})
            except (urllib.error.URLError, OSError):
                pass
        return finish(*remove_from_branch(root, job, note))
    before = snapshot(root, dt) if stage in ("regenerate", "validate") else None
    if stage == "include" and (job.get("params") or {}).get("target") == "existing":
        head = remote_sha(root / "repos" / "nd_test_bot", job["params"]["branch"])
        if not head:
            return finish("failed", "", f"Branch {job['params']['branch']} was not found on the remote, so there is nothing to push into. "
                                        f"Check the name, or create a new branch from another one.", {})
        before = {"remote_sha": head}
    if stage in ("regenerate", "validate"):
        backup = backup_testcases(root, dt, jid)
    if stage in ("generate", "regenerate") and args.skill_dir is not None:
        refresh_research(root, args.skill_dir, dt)      # PR snapshot = the state this run starts from

    work = root / "out" / dt / ".dashboard"
    work.mkdir(parents=True, exist_ok=True)
    result_file = work / f"{jid}.result.json"
    cmd = [args.claude, "-p", build_prompt(job, result_file),
           "--plugin-dir", str(args.skill_dir),
           "--output-format", "stream-json", "--verbose",
           "--permission-mode", args.permission_mode]
    cmd += ["--model", args.model]
    env = {**os.environ, "BUGREG_PROJECT_ROOT": str(root)}
    env.pop("TC_WORKER_TOKEN", None)
    if secrets.get("device_password"):
        env["BUGREG_DEVICE_PASSWORD"] = secrets["device_password"]
    if secrets.get("unfixed_device_password"):
        env["BUGREG_UNFIXED_DEVICE_PASSWORD"] = secrets["unfixed_device_password"]

    proc = subprocess.Popen(cmd, cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, errors="replace", start_new_session=True)
    lines: queue.Queue[str] = queue.Queue()
    ended = threading.Event()   # claude printed its final "result" event

    def pump() -> None:
        assert proc.stdout
        for raw in proc.stdout:
            try:
                kind = json.loads(raw).get("type")
                if kind == "result":
                    ended.set()
                elif kind == "assistant":
                    ended.clear()     # claude woke up again (a background task finished) and is working
            except (ValueError, AttributeError):
                pass
            for line in log_lines(raw):
                lines.put(line)

    threading.Thread(target=pump, daemon=True).start()
    deadline = time.time() + STAGE_TIMEOUT_MIN[stage] * 60
    stopped = ""
    linger_since: float | None = None
    pending = f"Worker {api.worker}: running the bug-regression skill, stage {stage}, in {root}\n"
    while True:
        alive = proc.poll() is None
        try:
            time.sleep(FLUSH_SEC if alive else 0.5)
        except KeyboardInterrupt:      # stopping the worker must not leave claude running
            kill_group(proc)
            finish("cancelled", "", "The worker was stopped while the job was running.", {})
            raise
        while not lines.empty():
            pending += lines.get() + "\n"
        try:
            reply = api.post(f"/tc-worker/jobs/{jid}/progress", {"log": scrub(pending, secret_values)})
            pending = ""
            if reply.get("cancel") and alive and not stopped:
                stopped = "cancelled"
                kill_group(proc)
        except (urllib.error.URLError, OSError):
            pass   # keep the text and send it with the next flush
        # claude said it is finished but the process is still there: something it started in the
        # background is still open. The result is written, so close it instead of waiting for ever.
        # Only when the result file is really there: a turn can end while a test run is still going in
        # the background and claude resumes when it finishes, and that run must not be cut short.
        if not (alive and not stopped and ended.is_set() and read_result(result_file)):
            linger_since = None
        else:
            linger_since = linger_since or time.time()
            if time.time() - linger_since > LINGER_SEC:
                tree = descendants(proc.pid)
                pending += (f"[worker] claude finished {LINGER_SEC}s ago but is still running; a background task "
                            f"it started is still open. Stopping it.\n"
                            + "".join(f"[worker]   stopped pid {p}: {c[:120]}\n" for p, c in tree))
                kill_group(proc, tree)
        if alive and not stopped and time.time() > deadline:
            stopped = "timeout"
            kill_group(proc)
        if not alive and lines.empty():
            break

    if stopped == "cancelled":
        return finish("cancelled", "", "Cancelled from the dashboard.", {})
    if stopped == "timeout":
        return finish("failed", "", f"Stopped after {STAGE_TIMEOUT_MIN[stage]} minutes without finishing.", {})
    result = read_result(result_file)
    if proc.returncode != 0 and not result:
        return finish("failed", "", f"claude exited with code {proc.returncode}. See the log.", {})
    status, outcome, message, final = verify(root, job, result, before)
    if stage == "validate" and status == "done" and not (outcome == "no" and final.get("changed_files")):
        try:
            commit_validation_state(root, job, final)
        except OSError as exc:
            print(f"  could not record the validation state: {exc}", flush=True)
    if stage == "regenerate" and status == "done" and outcome == "updated":
        message += supersede_validation(root, dt)
    finish(status, outcome, message, final)


# ---------------------------------------------------------------------------
# Start-up
# ---------------------------------------------------------------------------

def setup_problems(args: argparse.Namespace) -> list[str]:
    root, skill = args.project_root, args.skill_dir
    out = []
    if not args.token:
        out.append("No worker token: set TC_WORKER_TOKEN (the same value as on the backend) or pass --token.")
    if not shutil.which(args.claude):
        out.append(f"The claude CLI was not found ({args.claude}).")
    for need in (".env", "repos/nd_test_bot"):
        if not (root / need).exists():
            out.append(f"{root} is not a bug-regression project folder: {need} is missing.")
    try:
        if SKILL_MARKER not in (skill / "SKILL.md").read_text():
            out.append(f"{skill}/SKILL.md has no \"{SKILL_MARKER}\" section. Use the copy shipped with perda.")
    except OSError:
        out.append(f"No skill at {skill} (SKILL.md missing).")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the perda dashboard's Claude jobs on this workstation.")
    ap.add_argument("--server", default=os.environ.get("PERDA_API_URL", DEFAULT_SERVER))
    ap.add_argument("--token", default=os.environ.get("TC_WORKER_TOKEN", ""))
    ap.add_argument("--project-root", type=Path, default=os.environ.get("BUGREG_PROJECT_ROOT"),
                    help="bug-regression project folder (.env, repos/, out/)")
    ap.add_argument("--skill-dir", type=Path, default=Path(os.environ.get("BUGREG_SKILL_DIR", DEFAULT_SKILL_DIR)))
    ap.add_argument("--claude", default="claude", help="claude CLI executable")
    ap.add_argument("--model", default=os.environ.get("TC_WORKER_MODEL", "sonnet"),
                    help="model for the jobs (default: sonnet)")
    ap.add_argument("--permission-mode", default="bypassPermissions",
                    help="claude permission mode. Jobs run unattended, so anything that prompts will stall.")
    ap.add_argument("--name", default=f"{os.environ.get('USER', 'worker')}@{socket.gethostname()}")
    ap.add_argument("--once", action="store_true", help="run at most one job, then exit")
    args = ap.parse_args()
    if not args.project_root:
        ap.error("--project-root (or BUGREG_PROJECT_ROOT) is required")
    args.project_root = Path(args.project_root).expanduser().resolve()
    args.skill_dir = args.skill_dir.expanduser().resolve()

    problems = setup_problems(args)
    if problems:
        print("Cannot start:\n  - " + "\n  - ".join(problems), file=sys.stderr)
        return 2

    api = Api(args.server, args.token, args.name)
    last_publish = 0.0
    print(f"Worker {args.name} -> {api.server}\n  project: {args.project_root}\n  skill:   {args.skill_dir}\n"
          f"  model:   {args.model}\n"
          f"  claude permission mode: {args.permission_mode}\nWaiting for jobs (Ctrl+C to stop).", flush=True)
    warned = False
    while True:
        try:
            job = api.post("/tc-worker/claim", {"project_root": str(args.project_root)}).get("job")
            warned = False
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 503):
                print(f"Backend refused the worker: {exc.read().decode(errors='replace')[:300]}", file=sys.stderr)
                return 2
            if exc.code == 404:
                print(f"{api.server} has no Claude-job endpoints: that backend is still running the old code. "
                      f"Deploy and restart it, or point --server at a backend that has them.", file=sys.stderr)
                return 2
            job = None
        except (urllib.error.URLError, OSError) as exc:
            if not warned:
                print(f"Backend not reachable ({exc}); retrying.", flush=True)
                warned = True
            job = None
        if job:
            try:
                run_job(api, args, job)
            except Exception as exc:  # one broken job must not stop the worker
                print(f"  job crashed: {exc!r}", flush=True)
                try:
                    api.post(f"/tc-worker/jobs/{job['id']}/finish",
                             {"status": "failed", "outcome": "", "message": f"Worker error: {exc}", "result": {}})
                except Exception:
                    pass
            publish_requirements(api, args.project_root)
            publish_files(api, args.project_root)
            last_publish = time.time()
            if args.once:
                return 0
        else:
            if time.time() - last_publish > 300:     # first idle pass, then every 5 minutes
                publish_requirements(api, args.project_root)
                publish_files(api, args.project_root)
                last_publish = time.time()
            time.sleep(POLL_SEC)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped.")
