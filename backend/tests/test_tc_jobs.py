"""Tests for the Claude job queue (tc_jobs) and the workstation worker's pure logic."""
import json
import os
import sys

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "tools"))

import database as db  # noqa: E402
import tc_jobs as tj  # noqa: E402
import tc_worker as tw  # noqa: E402


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(tj, "SECRET_DIR", tmp_path / "secrets")
    monkeypatch.setenv("TC_WORKER_TOKEN", "tok")
    db.init_db()


def cell(dt, field):
    return db.get_ticket_statuses().get(dt, {}).get(field, "")


def run(dt, stage, outcome, result=None, **params):
    """Queue a job, claim it and finish it as done."""
    job = tj.create_job(dt, stage, params, "Giri")
    claimed = tj.claim("w1")
    assert claimed["id"] == job["id"]
    return tj.finish(job["id"], "w1", "done", outcome, "ok", result or {}), claimed


# ---- stage order ----------------------------------------------------------

def test_validate_and_include_refused_until_previous_stage_is_complete():
    with pytest.raises(tj.JobError) as e:
        tj.create_job("DT-1", "validate", {"device_id": "6603083402", "device_password": "pw"}, "Giri")
    assert e.value.status == 409 and "Generate" in str(e.value)
    with pytest.raises(tj.JobError):
        tj.create_job("DT-1", "include", {"branch": "main"}, "Giri")

    run("DT-1", "generate", "generated")
    assert cell("DT-1", "generated_tcs") == "Yes"
    with pytest.raises(tj.JobError) as e:
        tj.create_job("DT-1", "include", {"branch": "main"}, "Giri")
    assert e.value.status == 409 and "Validate" in str(e.value)

    run("DT-1", "validate", "partial", device_id="6603083402", device_password="pw")
    assert cell("DT-1", "validated") == "Partial"
    done, _ = run("DT-1", "include", "pushed", {"branch": "bugreg/DT-1-on-main"}, branch="main")
    assert done["status"] == "done"
    assert cell("DT-1", "included_in_runs") == "bugreg/DT-1-on-main"


def test_validated_no_does_not_unlock_include():
    run("DT-2", "generate", "generated")
    run("DT-2", "validate", "no", device_id="6603083402", device_password="pw")
    assert cell("DT-2", "validated") == "No"
    with pytest.raises(tj.JobError):
        tj.create_job("DT-2", "include", {"branch": "main"}, "Giri")


def test_one_job_per_ticket_at_a_time():
    tj.create_job("DT-3", "generate", {}, "Giri")
    with pytest.raises(tj.JobError) as e:
        tj.create_job("DT-3", "generate", {}, "Giri")
    assert e.value.status == 409


# ---- generate cell --------------------------------------------------------

def test_generate_marks_in_progress_and_restores_on_failure_or_cancel():
    db.set_ticket_status("DT-4", "generated_tcs", "No", "x")
    job = tj.create_job("DT-4", "generate", {}, "Giri")
    assert cell("DT-4", "generated_tcs") == "In progress"
    tj.claim("w1")
    tj.finish(job["id"], "w1", "failed", "failed", "no evidence", {})
    assert cell("DT-4", "generated_tcs") == "No"

    job = tj.create_job("DT-4", "generate", {}, "Giri")
    assert tj.cancel_job(job["id"])["status"] == "cancelled"
    assert cell("DT-4", "generated_tcs") == "No"
    assert tj.claim("w1") is None


def test_generate_covered_sets_na():
    run("DT-5", "generate", "covered")
    assert cell("DT-5", "generated_tcs") == "N/A"


def test_done_without_a_usable_outcome_becomes_failed():
    job = tj.create_job("DT-6", "generate", {}, "Giri")
    tj.claim("w1")
    assert tj.finish(job["id"], "w1", "done", "whatever", "", {})["status"] == "failed"
    run("DT-7", "generate", "generated")
    run("DT-7", "validate", "yes", device_id="6603083402", device_password="pw")
    job = tj.create_job("DT-7", "include", {"branch": "main"}, "Giri")
    tj.claim("w1")
    assert tj.finish(job["id"], "w1", "done", "pushed", "", {"branch": "bad branch"})["status"] == "failed"
    assert cell("DT-7", "included_in_runs") == ""


# ---- input checks ---------------------------------------------------------

@pytest.mark.parametrize("dt", ["CN-12", "DT-", "DT-1; rm -rf /", "dt 1"])
def test_only_dt_and_octo_keys(dt):
    with pytest.raises(tj.JobError):
        tj.create_job(dt, "generate", {}, "Giri")


@pytest.mark.parametrize("branch", ["", "-x", "a..b", "a b", "a;b", "x/", "x.lock", "$(id)"])
def test_bad_branch_names(branch):
    assert not tj.valid_branch(branch) and not tw.valid_branch(branch)


def test_validate_params():
    with pytest.raises(tj.JobError):
        tj.clean_params("validate", {"device_id": "66 03", "device_password": "p"})
    with pytest.raises(tj.JobError):
        tj.clean_params("validate", {"device_id": "6603083402"})
    with pytest.raises(tj.JobError):   # unfixed device needs its own password
        tj.clean_params("validate", {"device_id": "6603083402", "device_password": "p", "unfixed_device_id": "6603083306"})
    with pytest.raises(tj.JobError):
        tj.clean_params("validate", {"device_id": "6603083402", "device_password": "p",
                                     "unfixed_device_id": "6603083402", "unfixed_device_password": "p"})


# ---- secrets --------------------------------------------------------------

def test_password_is_not_in_the_database_and_is_handed_out_once(tmp_path):
    run("DT-8", "generate", "generated")
    job = tj.create_job("DT-8", "validate", {"device_id": "6603083402", "device_password": "S3cret!pw"}, "Giri")
    assert "S3cret!pw" not in json.dumps(job)
    assert b"S3cret!pw" not in (tmp_path / "t.db").read_bytes()
    assert "S3cret!pw" not in json.dumps(tj.overview())
    secret_file = tmp_path / "secrets" / f"{job['id']}.json"
    assert oct(secret_file.stat().st_mode & 0o777) == "0o600"

    claimed = tj.claim("w1")
    assert claimed["secrets"] == {"device_password": "S3cret!pw"}
    assert not secret_file.exists()
    assert "secrets" not in tj.get_job(job["id"])


def test_cancelled_job_drops_its_password(tmp_path):
    run("DT-9", "generate", "generated")
    job = tj.create_job("DT-9", "validate", {"device_id": "6603083402", "device_password": "pw"}, "Giri")
    tj.cancel_job(job["id"])
    assert not list((tmp_path / "secrets").glob("*.json"))


# ---- worker protocol ------------------------------------------------------

def test_token():
    tj.check_token("tok")
    with pytest.raises(tj.JobError) as e:
        tj.check_token("nope")
    assert e.value.status == 401


def test_feature_off_without_token(monkeypatch):
    monkeypatch.delenv("TC_WORKER_TOKEN")
    assert tj.overview()["enabled"] is False
    with pytest.raises(tj.JobError) as e:
        tj.create_job("DT-1", "generate", {}, "Giri")
    assert e.value.status == 503


def test_progress_appends_log_and_carries_cancel():
    job = tj.create_job("DT-10", "generate", {}, "Giri")
    tj.claim("w1")
    assert tj.progress(job["id"], "w1", "one\n") == {"cancel": False}
    tj.progress(job["id"], "w1", "two\n")
    assert tj.get_job(job["id"])["log"] == "one\ntwo\n"
    assert tj.get_job(job["id"], after=4)["log"] == "two\n"
    assert tj.progress(job["id"], "other", "x") == {"cancel": True}   # not that worker's job
    tj.cancel_job(job["id"])
    assert tj.progress(job["id"], "w1", "") == {"cancel": True}
    assert tj.finish(job["id"], "w1", "cancelled", "", "stopped", {})["status"] == "cancelled"


def test_silent_worker_fails_the_job(monkeypatch):
    job = tj.create_job("DT-11", "generate", {}, "Giri")
    tj.claim("w1")
    monkeypatch.setattr(tj, "STALE_RUNNING_SEC", -1)
    ov = tj.overview()
    assert [j["status"] for j in ov["jobs"] if j["id"] == job["id"]] == ["failed"]
    assert cell("DT-11", "generated_tcs") == ""
    assert ov["worker"]["online"] is True


def test_include_appends_to_existing_runs_text():
    run("DT-12", "generate", "generated")
    run("DT-12", "validate", "yes", device_id="6603083402", device_password="pw")
    db.set_ticket_status("DT-12", "included_in_runs", "nightly", "x")
    run("DT-12", "include", "pushed", {"branch": "bugreg/DT-12-on-main"}, branch="main")
    assert cell("DT-12", "included_in_runs") == "nightly, bugreg/DT-12-on-main"


# ---- worker: checks on disk ----------------------------------------------

def project(tmp_path, dt="DT-20", tc=True, validated=False):
    out = tmp_path / "out" / dt
    out.mkdir(parents=True)
    if tc:
        (out / "TC_1_GPS_X.py").write_text("x")
    (out / "bug_analysis.json").write_text(json.dumps({"device_validation": {"fixed": "pass"}} if validated else {}))
    return tmp_path


def test_worker_precheck_uses_files_not_the_status_column(tmp_path):
    root = project(tmp_path, tc=False)
    val = {"dt": "DT-20", "stage": "validate", "params": {"device_id": "6603083402"}, "secrets": {"device_password": "p", "unfixed_device_password": "q"}}
    assert "Generated TCs is not complete" in tw.precheck(root, val)
    (root / "out" / "DT-20" / "TC_1_GPS_X.py").write_text("x")
    assert tw.precheck(root, val) is None
    assert "password" in tw.precheck(root, {**val, "secrets": {}})
    inc = {"dt": "DT-20", "stage": "include", "params": {"branch": "main"}}
    assert "Validated in device is not complete" in tw.precheck(root, inc)
    (root / "out" / "DT-20" / "bug_analysis.json").write_text(json.dumps({"device_validation": {"a": 1}}))
    assert tw.precheck(root, inc) is None
    assert tw.precheck(root, {"dt": "DT-20", "stage": "generate", "params": {}}) is None


def test_worker_verify(tmp_path, monkeypatch):
    root = project(tmp_path, validated=True)
    gen = {"dt": "DT-20", "stage": "generate", "params": {}}
    assert tw.verify(root, gen, {})[0] == "failed"                       # no result file
    assert tw.verify(root, gen, {"outcome": "failed", "summary": "why"})[:3] == ("failed", "failed", "why")
    status, outcome, _, result = tw.verify(root, gen, {"outcome": "generated"})
    assert (status, outcome, result["testcases"]) == ("done", "generated", ["TC_1_GPS_X.py"])
    assert tw.verify(root, {**gen, "dt": "DT-21"}, {"outcome": "generated"})[0] == "failed"   # claims files that are not there
    assert tw.verify(root, gen, {"outcome": "covered"})[:2] == ("done", "covered")

    val = {"dt": "DT-20", "stage": "validate", "params": {"device_id": "6603083402"}}
    assert tw.verify(root, val, {"outcome": "yes"})[1] == "partial"      # no unfixed device: never a full Yes
    val2 = {**val, "params": {"device_id": "6603083402", "unfixed_device_id": "6603083306"}}
    assert tw.verify(root, val2, {"outcome": "yes"})[:2] == ("done", "yes")

    inc = {"dt": "DT-20", "stage": "include", "params": {"branch": "main"}}
    monkeypatch.setattr(tw, "branch_on_origin", lambda repo, b, commit="": b == "bugreg/DT-20-on-main")
    assert tw.verify(root, inc, {"outcome": "pushed", "branch": "bugreg/DT-20-on-main"})[:2] == ("done", "pushed")
    assert tw.verify(root, inc, {"outcome": "pushed", "branch": "bugreg/other"})[0] == "failed"   # not on origin
    assert tw.verify(root, inc, {"outcome": "pushed", "branch": "main"})[0] == "failed"           # base itself


def test_worker_prompt_and_log_scrubbing(tmp_path):
    job = {"id": "a" * 32, "dt": "DT-20", "stage": "validate", "actor": "Giri",
           "params": {"device_id": "6603083402", "unfixed_device_id": "6603083306"}}
    prompt = tw.build_prompt(job, tmp_path / "r.json")
    assert prompt.startswith("/bug-regression:bug-regression dashboard-stage=validate ticket=DT-20")
    assert "device=6603083402" in prompt and "unfixed-device=6603083306" in prompt
    assert "BUGREG_DEVICE_PASSWORD" in prompt and "BUGREG_UNFIXED_DEVICE_PASSWORD" in prompt
    inc = tw.build_prompt({**job, "stage": "include", "params": {"branch": "release/6.16"}}, tmp_path / "r.json")
    assert "base-branch=release/6.16" in inc

    assert tw.scrub("sshpass -p hunter2 ssh", ["hunter2", ""]) == "sshpass -p *** ssh"
    ev = {"type": "assistant", "message": {"content": [
        {"type": "text", "text": "Reading the diff"},
        {"type": "tool_use", "name": "Bash", "input": {"command": "git  diff\nHEAD"}}]}}
    assert tw.log_lines(json.dumps(ev)) == ["Reading the diff", "  > Bash: git diff HEAD"]
    assert tw.log_lines("not json") == ["not json"]
    assert tw.log_lines(json.dumps({"type": "system"})) == []


# ---- regenerate after merge ------------------------------------------------

def _validated_ticket(dt, validated="Yes"):
    run(dt, "generate", "generated")
    run(dt, "validate", validated.lower(), device_id="6603083402", device_password="pw")
    db.set_ticket_status(dt, "included_in_runs", "nightly", "x")


def test_regenerate_needs_generated_tcs_first():
    with pytest.raises(tj.JobError) as e:
        tj.create_job("DT-30", "regenerate", {}, "Giri")
    assert e.value.status == 409 and "Generate" in str(e.value)


def test_regenerate_does_not_touch_the_cell_while_running():
    run("DT-31", "generate", "generated")
    tj.create_job("DT-31", "regenerate", {}, "Giri")
    assert cell("DT-31", "generated_tcs") == "Yes"          # never "In progress": the old testcases still stand
    assert tj.claim("w1")["stage"] == "regenerate"


def test_regenerate_updated_clears_validation_and_keeps_run_text():
    _validated_ticket("DT-32", "yes")
    done, _ = run("DT-32", "regenerate", "updated", {"summary": "Oracle renamed."})
    assert done["status"] == "done" and done["result"]["outcome"] == "updated"
    assert cell("DT-32", "validated") == ""
    assert cell("DT-32", "generated_tcs") == "Yes"
    assert cell("DT-32", "included_in_runs") == "nightly"   # typed by people: not cleared, only named
    assert "cleared" in done["message"] and "nightly" in done["message"]
    # the include stage is closed again until the new testcases are validated
    with pytest.raises(tj.JobError) as e:
        tj.create_job("DT-32", "include", {"branch": "main"}, "Giri")
    assert e.value.status == 409


@pytest.mark.parametrize("outcome", ["unchanged", "not_merged"])
def test_regenerate_without_a_change_leaves_every_cell_alone(outcome):
    _validated_ticket("DT-33", "partial")
    before = db.get_ticket_statuses()["DT-33"]
    done, _ = run("DT-33", "regenerate", outcome)
    assert done["status"] == "done"
    after = db.get_ticket_statuses()["DT-33"]
    assert {k: after[k] for k in ("generated_tcs", "validated", "included_in_runs")} == \
           {k: before[k] for k in ("generated_tcs", "validated", "included_in_runs")}


def test_regenerate_failed_or_unusable_changes_nothing():
    _validated_ticket("DT-34", "yes")
    job = tj.create_job("DT-34", "regenerate", {}, "Giri")
    tj.claim("w1")
    assert tj.finish(job["id"], "w1", "done", "whatever", "", {})["status"] == "failed"
    assert cell("DT-34", "validated") == "Yes"
    job = tj.create_job("DT-34", "regenerate", {}, "Giri")
    tj.claim("w1")
    tj.finish(job["id"], "w1", "failed", "failed", "no evidence", {})
    assert cell("DT-34", "validated") == "Yes" and cell("DT-34", "generated_tcs") == "Yes"


def test_validate_result_overwrites_the_cleared_cell():
    _validated_ticket("DT-35", "yes")
    run("DT-35", "regenerate", "updated")
    run("DT-35", "validate", "partial", device_id="6603083402", device_password="pw")
    assert cell("DT-35", "validated") == "Partial"


# ---- regenerate: the worker's own checks -------------------------------------

def regen_project(tmp_path, dt="DT-40"):
    out = tmp_path / "out" / dt
    out.mkdir(parents=True)
    (out / "TC_1_GPS_A.py").write_text("a1")
    (out / "TC_2_GPS_B.py").write_text("b1")
    (out / "bug_analysis.json").write_text(json.dumps({"x": 1, "device_validation": {"6603083402": "pass"}}))
    return tmp_path


REGEN = {"dt": "DT-40", "stage": "regenerate", "params": {}}


def test_snapshot_and_verify_decide_updated_from_the_files(tmp_path):
    root = regen_project(tmp_path)
    before = tw.snapshot(root, "DT-40")
    out = root / "out" / "DT-40"

    # claude says "updated" but nothing changed: it is unchanged
    st, outcome, msg, res = tw.verify(root, REGEN, {"outcome": "updated", "summary": "s"}, before)
    assert (st, outcome) == ("done", "unchanged") and "no testcase file changed" in msg

    # an edited file, a new file, a retired file each count
    (out / "TC_1_GPS_A.py").write_text("a2")
    st, outcome, _, res = tw.verify(root, REGEN, {"outcome": "updated"}, before)
    assert (st, outcome, res["changed_files"]) == ("done", "updated", ["TC_1_GPS_A.py"])
    (out / "TC_3_GPS_C.py").write_text("c")
    (out / "TC_2_GPS_B.py").unlink()
    st, outcome, _, res = tw.verify(root, REGEN, {"outcome": "unchanged"}, before)   # claude under-reports
    assert (st, outcome) == ("done", "updated")
    assert res["changed_files"] == ["TC_1_GPS_A.py", "TC_2_GPS_B.py", "TC_3_GPS_C.py"]
    assert res["testcases"] == ["TC_1_GPS_A.py", "TC_3_GPS_C.py"]


def test_verify_not_merged_failed_and_empty(tmp_path):
    root = regen_project(tmp_path)
    before = tw.snapshot(root, "DT-40")
    st, outcome, _, res = tw.verify(root, REGEN, {"outcome": "not_merged", "summary": "PR #1 still open"}, before)
    assert (st, outcome) == ("done", "not_merged") and res["testcases"] == ["TC_1_GPS_A.py", "TC_2_GPS_B.py"]
    assert tw.verify(root, REGEN, {"outcome": "failed", "summary": "why"}, before)[:3] == ("failed", "failed", "why")
    assert tw.verify(root, REGEN, {}, before)[0] == "failed"
    assert tw.verify(root, REGEN, {"outcome": "bogus"}, before)[0] == "failed"
    (root / "out" / "DT-40" / "TC_1_GPS_A.py").write_text("changed")
    assert tw.verify(root, REGEN, {"outcome": "not_merged"}, before)[0] == "failed"   # said "nothing to do", but edited
    for f in (root / "out" / "DT-40").glob("TC_*.py"):
        f.unlink()
    assert tw.verify(root, REGEN, {"outcome": "updated"}, before)[0] == "failed"      # every testcase gone


def test_backup_restores_an_unfinished_regenerate(tmp_path):
    root = regen_project(tmp_path)
    out = root / "out" / "DT-40"
    (out / "retired").mkdir()
    (out / "retired" / "TC_old.py").write_text("old")
    backup = tw.backup_testcases(root, "DT-40", "a" * 32)
    # a half-finished run: edits one, deletes one, adds one, retires one, rewrites the analysis
    (out / "TC_1_GPS_A.py").write_text("half-edited")
    (out / "TC_2_GPS_B.py").unlink()
    (out / "TC_9_NEW.py").write_text("new")
    (out / "retired" / "TC_just_retired.py").write_text("x")
    (out / "bug_analysis.json").write_text("{}")
    tw.restore_testcases(root, "DT-40", backup)
    assert tw.snapshot(root, "DT-40") == {"TC_1_GPS_A.py": tw.hashlib.sha256(b"a1").hexdigest(),
                                          "TC_2_GPS_B.py": tw.hashlib.sha256(b"b1").hexdigest()}
    assert json.loads((out / "bug_analysis.json").read_text())["x"] == 1
    assert sorted(p.name for p in (out / "retired").glob("*")) == ["TC_old.py"]


def test_supersede_validation_keeps_the_old_run_as_history(tmp_path):
    root = regen_project(tmp_path)
    assert "superseded_device_validation" in tw.supersede_validation(root, "DT-40")
    data = json.loads((root / "out" / "DT-40" / "bug_analysis.json").read_text())
    assert "device_validation" not in data and data["superseded_device_validation"] == [{"6603083402": "pass"}]
    assert data["x"] == 1
    assert tw.supersede_validation(root, "DT-40") == ""          # nothing left to move
    assert not tw.has_device_validation(root, "DT-40")           # include is closed on disk too


def test_regenerate_precheck_and_prompt(tmp_path):
    root = regen_project(tmp_path)
    skill = tmp_path / "skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("## 12. Dashboard-driven stages")
    assert "Regenerate after merge" in tw.precheck(root, REGEN, skill)         # section not pasted yet
    (skill / "SKILL.md").write_text("Dashboard-driven stages\n### Stage `regenerate` (Regenerate after merge)")
    assert tw.precheck(root, REGEN, skill) is None
    (root / "out" / "DT-40" / "bug_analysis.json").unlink()
    assert "bug_analysis.json" in tw.precheck(root, REGEN, skill)
    for f in (root / "out" / "DT-40").glob("TC_*.py"):
        f.unlink()
    assert "Generated TCs is not complete" in tw.precheck(root, REGEN, skill)

    prompt = tw.build_prompt({**REGEN, "id": "a" * 32, "actor": "Giri"}, tmp_path / "r.json")
    assert prompt.startswith("/bug-regression:bug-regression dashboard-stage=regenerate ticket=DT-40")
    assert "Regenerate after merge" in prompt and "Do not touch a device" in prompt


# ---- claude that finished but will not exit ----------------------------------

def test_descendants_finds_a_shell_that_left_the_session_and_kill_group_stops_it():
    import subprocess
    import time
    # like claude's Bash tool: a child started with its own session, which a plain process-group kill misses
    proc = subprocess.Popen(["bash", "-c", "setsid sleep 300 & wait"], start_new_session=True,
                            stdout=subprocess.DEVNULL)
    try:
        for _ in range(50):
            tree = tw.descendants(proc.pid)
            if any("sleep 300" in cmd for _, cmd in tree):
                break
            time.sleep(0.1)
        pids = [p for p, cmd in tree if "sleep 300" in cmd]
        assert pids
        tw.kill_group(proc, tree)
        time.sleep(0.3)
        for pid in pids:
            with pytest.raises(OSError):
                os.kill(pid, 0)
        assert proc.poll() is not None
    finally:
        proc.kill()


def test_descendants_of_a_process_without_children_is_empty():
    import subprocess
    p = subprocess.Popen(["sleep", "5"])
    try:
        assert tw.descendants(p.pid) == []
    finally:
        p.kill()


# ---- not_testable ----------------------------------------------------------------

def test_not_testable_sets_na_and_a_failed_job_does_not():
    done, _ = run("DT-50", "generate", "not_testable", {"summary": "No lever: port 5000 is behind hotspot mode."})
    assert done["status"] == "done" and done["result"]["outcome"] == "not_testable"
    assert cell("DT-50", "generated_tcs") == "N/A"
    # N/A is not "generated": validate and include stay closed
    with pytest.raises(tj.JobError):
        tj.create_job("DT-50", "validate", {"device_id": "6603083402", "device_password": "pw"}, "Giri")
    # a ticket that failed (could change later) goes back to blank, so it is run again
    job = tj.create_job("DT-51", "generate", {}, "Giri")
    tj.claim("w1")
    tj.finish(job["id"], "w1", "failed", "failed", "fix PR not merged", {})
    assert cell("DT-51", "generated_tcs") == ""


def test_worker_accepts_not_testable_without_files(tmp_path):
    (tmp_path / "out" / "DT-52").mkdir(parents=True)
    job = {"dt": "DT-52", "stage": "generate", "params": {}}
    st, outcome, msg, _ = tw.verify(tmp_path, job, {"outcome": "not_testable"})
    assert (st, outcome) == ("done", "not_testable") and "cannot be turned" in msg
    st, outcome, msg, _ = tw.verify(tmp_path, job, {"outcome": "not_testable", "summary": "why"})
    assert msg == "why"


# ---- device preflight --------------------------------------------------------------

def test_check_device_info():
    ok = {"device_id": "1", "device_type": "octo", "device_ip": "10.0.0.5", "ssh_username": "ubuntu"}
    assert tw.check_device_info(ok, "125212600020", "Device") is None
    msg = tw.check_device_info({"error": "device '1' not found in ip_db.mycollection -- check the ID"}, "125212600020", "Device")
    assert "not registered on this workstation" in msg and "125212600020" in msg
    assert "cannot be looked up" in tw.check_device_info({"error": "could not query local mongod: x"}, "1", "Device")
    assert tw.check_device_info({"error": "pymongo not importable -- run this with the venv"}, "1", "Device") is None  # a tool problem, not a verdict
    assert "unrecognised type" in tw.check_device_info({**ok, "device_type": "x", "ssh_username": None}, "1", "Device")
    assert "no IP" in tw.check_device_info({**ok, "device_ip": None}, "1", "Device")


def test_check_ssh():
    chk = lambda rc, err: tw.check_ssh(rc, err, "Device", "125212600020", "ubuntu", "172.16.16.41")  # noqa: E731
    assert chk(255, "ubuntu@172.16.16.41: Permission denied (publickey,password).") is None   # answers, wants a login
    assert chk(0, "") is None
    changed = chk(255, "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.")
    assert "ssh-keygen -R 172.16.16.41" in changed and "reflashed" in changed
    assert "not reachable" in chk(255, "ssh: connect to host 172.16.16.41 port 22: Connection timed out")
    assert "not reachable" in chk(124, "timed out")
    assert "not reachable" in chk(255, "ssh: connect to host 1.2.3.4 port 22: No route to host")
    assert chk(255, "Host key verification failed.") is None      # an unknown host is left to the run itself


def test_validate_precheck_stops_before_claude_on_a_bad_device(tmp_path, monkeypatch):
    root = regen_project(tmp_path, "DT-60")
    skill = tmp_path / "skill"
    (skill / "scripts").mkdir(parents=True)
    (skill / "scripts" / "detect_device.py").write_text("")
    (root / ".venv" / "bin").mkdir(parents=True)
    (root / ".venv" / "bin" / "python3").write_text("")
    job = {"dt": "DT-60", "stage": "validate", "secrets": {"device_password": "p", "unfixed_device_password": "q"},
           "params": {"device_id": "125212600020", "unfixed_device_id": "103212503890"}}

    answers = {"125212600020": {"error": "device '125212600020' not found in ip_db.mycollection"}}
    def fake_run(cmd, timeout):
        if cmd[0].endswith("python3"):
            return 0, json.dumps(answers.get(cmd[-1], {"device_type": "bagheera3", "device_ip": "10.0.0.9", "ssh_username": "ubuntu"})), ""
        return 255, "ubuntu@10.0.0.9: Permission denied (publickey,password).", ""
    monkeypatch.setattr(tw, "_run", fake_run)

    assert "not registered on this workstation" in tw.precheck(root, job, skill)            # main device unknown
    answers.clear()
    assert tw.precheck(root, job, skill) is None                                           # both fine
    answers["103212503890"] = {"error": "device '103212503890' not found in ip_db.mycollection"}
    assert tw.precheck(root, job, skill).startswith("Unfixed device 103212503890")         # the second one is checked too
    monkeypatch.setattr(tw, "PREFLIGHT", False)
    assert tw.precheck(root, job, skill) is None                                           # switched off


def test_validate_lists_what_is_left_to_validate(tmp_path):
    out = tmp_path / "out" / "DT-1"
    out.mkdir(parents=True)
    (out / "TC_1_A.py").write_text("a")
    (out / "TC_2_B.py").write_text("b")
    (out / "bug_analysis.json").write_text(json.dumps({"device_validation": {"x": 1}}))
    job = {"dt": "DT-1", "stage": "validate", "params": {"device_id": "1", "unfixed_device_id": ""}}
    result = {"outcome": "yes", "testcases": ["TC_1_A.py"], "remaining": ["Octo not exercised", "Octo not exercised", ""]}
    status, outcome, _, res = tw.verify(tmp_path, job, result)
    assert (status, outcome) == ("done", "partial")
    rem = res["remaining"]
    assert any("Fail-without-the-fix" in r for r in rem)
    assert any(r.startswith("TC_2:") and "not run yet" in r for r in rem)
    assert rem.count("Octo not exercised") == 1
    # with an unfixed device and a clean yes, nothing is left
    job["params"]["unfixed_device_id"] = "2"
    result = {"outcome": "yes", "testcases": ["TC_1_A.py", "TC_2_B.py"], "remaining": []}
    assert tw.verify(tmp_path, job, result)[3]["remaining"] == []


def test_validate_reports_reason_and_corrections_from_the_files(tmp_path):
    out = tmp_path / "out" / "DT-2"
    out.mkdir(parents=True)
    (out / "TC_1_A.py").write_text("old")
    (out / "bug_analysis.json").write_text(json.dumps({"device_validation": {"x": 1}}))
    job = {"dt": "DT-2", "stage": "validate", "params": {"device_id": "1", "unfixed_device_id": "2"}}
    before = tw.snapshot(tmp_path, "DT-2")
    backup = tw.backup_testcases(tmp_path, "DT-2", "j" * 32)
    (out / "TC_1_A.py").write_text("new")            # Claude corrected the testcase
    result = {"outcome": "no", "testcases": ["TC_1_A.py"], "reason": "log line was reworded", "reason_category": "testcase",
              "corrections": [{"testcase": "TC_1_A.py", "what": "new log line", "why": "review renamed it"}]}
    status, outcome, _, res = tw.verify(tmp_path, job, result, before)
    assert (status, outcome) == ("done", "no")
    assert res["changed_files"] == ["TC_1_A.py"] and res["corrections"][0]["what"] == "new log line"
    assert res["reason_category"] == "testcase" and res["remaining"][0].startswith("Why: [testcase]")
    # a failure that was not fixed: the unproven edit is undone, content only
    assert tw.revert_edits(tmp_path, "DT-2", backup) == ["TC_1_A.py"]
    assert (out / "TC_1_A.py").read_text() == "old"
    # a rename (Jira TC id replacing the placeholder) is not undone
    (out / "TC_1_A.py").rename(out / "TC_9_A.py")
    assert tw.revert_edits(tmp_path, "DT-2", backup) == [] and (out / "TC_9_A.py").exists()


def test_validate_no_without_reason_and_testcase_blamed_but_unchanged(tmp_path):
    out = tmp_path / "out" / "DT-3"
    out.mkdir(parents=True)
    (out / "TC_1_A.py").write_text("x")
    (out / "bug_analysis.json").write_text(json.dumps({"device_validation": {"x": 1}}))
    job = {"dt": "DT-3", "stage": "validate", "params": {"device_id": "1"}}
    before = tw.snapshot(tmp_path, "DT-3")
    rem = tw.verify(tmp_path, job, {"outcome": "no", "testcases": ["TC_1_A.py"]}, before)[3]["remaining"]
    assert rem[0].startswith("Claude gave no reason")
    rem = tw.verify(tmp_path, job, {"outcome": "no", "reason": "r", "reason_category": "testcase"}, before)[3]["remaining"]
    assert any("did not change it" in r for r in rem)


def _ticket(tmp_path, dt, analysis):
    d = tmp_path / "out" / dt
    d.mkdir(parents=True)
    (d / "TC_1_A.py").write_text("x")
    (d / "bug_analysis.json").write_text(json.dumps(analysis))


def test_requirements_standard_section_and_older_formats(tmp_path):
    _ticket(tmp_path, "DT-10", {"validation_requirements": {
        "runs_on": ["Krait", "bagheera2"], "na_on": ["octo"], "needs": ["SD card"],
        "fixed_build": "6.17.rc.2 with PR 3594", "unfixed_build": "6.16"}})
    r = tw.requirements(tmp_path, "DT-10")
    assert r["runs_on"] == ["krait", "bagheera2"] and r["na_on"] == ["octo"] and r["needs"] == ["SD card"]
    assert r["fixed_build"].startswith("6.17") and r["testcases"] == ["TC_1_A.py"]
    # DT-5280 style
    _ticket(tmp_path, "DT-11", {"family_scope": {"covers": ["bagheera3", "octo"], "na_on": ["krait"]},
                                "preconditions_for_validation": ["paired haptic motor"]})
    r = tw.requirements(tmp_path, "DT-11")
    assert r["runs_on"] == ["bagheera3", "octo"] and r["na_on"] == ["krait"] and r["needs"] == ["paired haptic motor"]
    # DT-5319 style: free text only becomes notes, nothing is invented
    _ticket(tmp_path, "DT-12", {"device_family": "No NA gate. SD mount probed at runtime."})
    r = tw.requirements(tmp_path, "DT-12")
    assert r["runs_on"] == [] and r["na_on"] == [] and "No NA gate" in r["notes"][0]


def test_device_of_a_na_platform_is_refused_before_claude_runs():
    req = {"runs_on": ["bagheera3", "octo"], "na_on": ["krait"]}
    msg = tw.wrong_platform({"device_type": "krait"}, req, "Device", "1")
    assert "not applicable on krait" in msg and "bagheera3, octo" in msg
    assert tw.wrong_platform({"device_type": "octo"}, req, "Device", "1") is None
    assert tw.wrong_platform({"device_type": "krait2"}, req, "Device", "1") is None   # only an explicit NA blocks
    assert tw.wrong_platform({}, req, "Device", "1") is None


def test_requirements_are_stored_cleaned_and_listed():
    n = tj.set_requirements({"DT-10": {"runs_on": ["krait", ""], "needs": ["x" * 900], "fixed_build": "b", "evil": 1},
                             "not-a-key": {"runs_on": ["a"]}})
    assert n == 1
    got = tj.overview()["requirements"]
    assert list(got) == ["DT-10"] and got["DT-10"]["runs_on"] == ["krait"]
    assert len(got["DT-10"]["needs"][0]) == 400 and "evil" not in got["DT-10"]
    with pytest.raises(tj.JobError):
        tj.set_requirements([1])


def test_include_needs_open_validation_items_accepted_by_a_named_person():
    run("DT-20", "generate", "generated", {"testcases": ["TC_1_A.py"]})
    run("DT-20", "validate", "partial", {"remaining": ["bagheera2 not run", "no unfixed device"]}, device_id="123456", device_password="pw")
    assert cell("DT-20", "validated") == "Partial"
    with pytest.raises(tj.JobError) as e:
        tj.create_job("DT-20", "include", {"branch": "main"}, "Giri")
    assert e.value.status == 409 and "2 item(s) open" in str(e.value)
    with pytest.raises(tj.JobError):                       # no name, no acceptance
        tj.create_job("DT-20", "include", {"branch": "main", "accept_gaps": True}, "")
    job = tj.create_job("DT-20", "include", {"branch": "main", "accept_gaps": True}, "Giri")
    assert job["status"] == "queued"
    ov = tj.overview()
    assert list(ov["accepted_gaps"].values()) == ["Giri"]
    tj.claim("w1"); tj.finish(job["id"], "w1", "failed", "", "push failed", {})
    # accepted once for that run: a retry does not ask again
    assert tj.create_job("DT-20", "include", {"branch": "main"}, "Giri")["status"] == "queued"


def test_a_new_validation_run_has_to_be_accepted_again_and_a_clean_one_needs_nothing():
    run("DT-21", "generate", "generated", {"testcases": ["TC_1_A.py"]})
    run("DT-21", "validate", "yes", {"remaining": ["x"]}, device_id="123456", device_password="pw", unfixed_device_id="654321", unfixed_device_password="pw")
    j = tj.create_job("DT-21", "include", {"branch": "main", "accept_gaps": True}, "Giri")
    tj.claim("w1"); tj.finish(j["id"], "w1", "failed", "", "x", {})
    run("DT-21", "validate", "yes", {"remaining": ["y"]}, device_id="123456", device_password="pw", unfixed_device_id="654321", unfixed_device_password="pw")
    with pytest.raises(tj.JobError):
        tj.create_job("DT-21", "include", {"branch": "main"}, "Giri")
    run("DT-21", "validate", "yes", {"remaining": []}, device_id="123456", device_password="pw", unfixed_device_id="654321", unfixed_device_password="pw")
    assert tj.create_job("DT-21", "include", {"branch": "main"}, "Giri")["status"] == "queued"


def test_testcase_files_sync_hash_first_and_prune():
    need = tj.sync_files("DT-30", {"TC_1_A.py": "h1", "TC_2_B.py": "h2", "evil.sh": "h3"}, [])
    assert need == ["TC_1_A.py", "TC_2_B.py"]                         # nothing stored yet; bad names ignored
    assert tj.sync_files("DT-30", {"TC_1_A.py": "h1", "TC_2_B.py": "h2"},
                         [{"name": "TC_1_A.py", "content": "print(1)"}, {"name": "TC_9_X.py", "content": "no"}]) == ["TC_2_B.py"]
    assert tj.get_file("DT-30", "TC_1_A.py")["content"] == "print(1)"
    with pytest.raises(tj.JobError) as e:
        tj.get_file("DT-30", "TC_9_X.py")                             # not listed, so never stored
    assert e.value.status == 404
    # a changed hash is asked for again; a removed file is dropped
    assert tj.sync_files("DT-30", {"TC_1_A.py": "h1b"}, []) == ["TC_1_A.py"]
    with pytest.raises(tj.JobError):
        tj.get_file("DT-30", "TC_2_B.py")
    with pytest.raises(tj.JobError):
        tj.get_file("DT-30", "../../etc/passwd")


def test_validate_modes_ask_only_for_the_chosen_devices():
    p, s = tj.clean_params("validate", {"mode": "fixed", "device_id": "123456", "device_password": "a", "unfixed_device_id": "999999"})
    assert p == {"mode": "fixed", "device_id": "123456"} and list(s) == ["device_password"]
    p, s = tj.clean_params("validate", {"mode": "unfixed", "unfixed_device_id": "654321", "unfixed_device_password": "b"})
    assert p == {"mode": "unfixed", "unfixed_device_id": "654321"} and list(s) == ["unfixed_device_password"]
    p, s = tj.clean_params("validate", {"mode": "both", "device_id": "123456", "device_password": "a",
                                        "unfixed_device_id": "654321", "unfixed_device_password": "b"})
    assert p["mode"] == "both" and set(s) == {"device_password", "unfixed_device_password"}
    with pytest.raises(tj.JobError):
        tj.clean_params("validate", {"mode": "unfixed", "device_id": "123456", "device_password": "a"})   # no unfixed device
    with pytest.raises(tj.JobError):
        tj.clean_params("validate", {"mode": "fixed", "device_id": "123456"})                              # no password
    with pytest.raises(tj.JobError):
        tj.clean_params("validate", {"mode": "sideways"})
    # older callers send no mode
    assert tj.clean_params("validate", {"device_id": "123456", "device_password": "a"})[0]["mode"] == "fixed"


def test_unfixed_only_run_completes_an_earlier_fixed_pass_to_yes(tmp_path):
    out = tmp_path / "out" / "DT-40"
    out.mkdir(parents=True)
    (out / "TC_1_A.py").write_text("v1")
    (out / "bug_analysis.json").write_text(json.dumps({"device_validation": {"x": 1}}))
    fixed = {"id": "j1", "dt": "DT-40", "stage": "validate", "params": {"mode": "fixed", "device_id": "123456"}}
    st, oc, _, res = tw.verify(tmp_path, fixed, {"outcome": "yes", "fixed_result": "pass", "testcases": ["TC_1_A.py"]})
    assert oc == "partial" and any("without the fix" in r for r in res["remaining"])
    tw.commit_validation_state(tmp_path, fixed, res)
    unf = {"id": "j2", "dt": "DT-40", "stage": "validate", "params": {"mode": "unfixed", "unfixed_device_id": "654321"}}
    st, oc, _, res = tw.verify(tmp_path, unf, {"outcome": "partial", "unfixed_result": "fail"})
    assert oc == "yes" and res["remaining"] == []
    tw.commit_validation_state(tmp_path, unf, res)
    # the testcase changes: the old evidence no longer counts
    (out / "TC_1_A.py").write_text("v2")
    now = tw.read_state(tmp_path, "DT-40")["TC_1_A.py"]
    assert now["fixed"] is None and now["unfixed"] is None


def test_unfixed_pass_proves_nothing_and_is_not_counted(tmp_path):
    out = tmp_path / "out" / "DT-41"
    out.mkdir(parents=True)
    (out / "TC_1_A.py").write_text("v1")
    (out / "bug_analysis.json").write_text(json.dumps({"device_validation": {"x": 1}}))
    unf = {"id": "j3", "dt": "DT-41", "stage": "validate", "params": {"mode": "unfixed", "unfixed_device_id": "654321"}}
    st, oc, msg, res = tw.verify(tmp_path, unf, {"outcome": "no", "unfixed_result": "pass", "reason": "binary has the fix",
                                                  "reason_category": "device"})
    assert (st, oc) == ("done", "inconclusive") and "left as it was" in msg
    assert any("PASSED on the device meant to lack the fix" in r for r in res["remaining"])
    # both devices, Claude says yes, but the unfixed side did not fail: only Partial
    both = {"id": "j4", "dt": "DT-41", "stage": "validate", "params": {"mode": "both", "device_id": "123456", "unfixed_device_id": "654321"}}
    assert tw.verify(tmp_path, both, {"outcome": "yes", "fixed_result": "pass", "unfixed_result": "pass"})[1] == "partial"
    assert tw.verify(tmp_path, both, {"outcome": "yes", "fixed_result": "pass", "unfixed_result": "fail"})[1] == "yes"
    assert tw.verify(tmp_path, both, {"outcome": "yes", "fixed_result": "fail"})[1] == "no"


def test_inconclusive_leaves_the_validated_cell_alone():
    run("DT-42", "generate", "generated", {"testcases": ["TC_1_A.py"]})
    run("DT-42", "validate", "partial", {}, device_id="123456", device_password="pw")
    assert cell("DT-42", "validated") == "Partial"
    run("DT-42", "validate", "inconclusive", {}, mode="unfixed", unfixed_device_id="654321", unfixed_device_password="pw")
    assert cell("DT-42", "validated") == "Partial"


def test_the_http_model_carries_the_validate_mode():
    """The popup's choice must survive the request model, or an unfixed-only run is read as fixed-only."""
    import main
    body = main.TcJobRequest(dt="DT-1", stage="validate", mode="unfixed",
                             unfixed_device_id="103432407292", unfixed_device_password="pw").model_dump()
    assert body["mode"] == "unfixed"
    params, secrets = tj.clean_params("validate", body)
    assert params == {"mode": "unfixed", "unfixed_device_id": "103432407292"} and list(secrets) == ["unfixed_device_password"]


def test_pushed_branch_is_found_over_ssh_when_the_https_origin_has_no_credentials(monkeypatch, tmp_path):
    sha = "291b52dfb28e1e2cd1e8da7d53eb838b1dc29974"
    seen = []

    class R:
        def __init__(self, rc, out=""):
            self.returncode, self.stdout = rc, out

    def fake_run(cmd, **kw):
        seen.append(cmd)
        if cmd[:3] == ["git", "remote", "get-url"]:
            return R(0, "https://github.com/netradyne/nd_test_bot.git\n")
        target = cmd[-2]
        if target == "origin":
            return R(128)                                              # no credentials for https
        return R(0, f"{sha}\trefs/heads/bugreg/x\n")
    monkeypatch.setattr(tw.subprocess, "run", fake_run)
    assert tw.remote_targets(tmp_path) == ["origin", "git@github.com:netradyne/nd_test_bot.git"]
    assert tw.branch_on_origin(tmp_path, "bugreg/x") is True
    assert tw.branch_on_origin(tmp_path, "bugreg/x", sha) is True
    assert tw.branch_on_origin(tmp_path, "bugreg/x", sha[:7]) is True
    assert tw.branch_on_origin(tmp_path, "bugreg/x", "0" * 40) is False   # a different commit is not the push

    monkeypatch.setattr(tw.subprocess, "run", lambda cmd, **kw: R(0, "https://github.com/a/b.git\n") if cmd[2] == "get-url" else R(2))
    assert tw.branch_on_origin(tmp_path, "bugreg/missing") is False        # on neither remote: really not pushed


def test_include_into_an_existing_branch_params_and_one_push_at_a_time():
    ok = {"branch": "6.16_qa_regression_fixes", "target": "existing", "confirm_push": True}
    assert tj.clean_params("include", ok)[0] == {"branch": "6.16_qa_regression_fixes", "target": "existing"}
    assert tj.clean_params("include", {"branch": "x", "target": "new"})[0] == {"branch": "x", "target": "new"}
    assert tj.clean_params("include", {"branch": "x"})[0]["target"] == "new"            # old callers keep the old behaviour
    with pytest.raises(tj.JobError):
        tj.clean_params("include", {"branch": "x", "target": "existing"})              # no confirmation
    for protected in ("main", "master", "origin/main", "MAIN"):
        with pytest.raises(tj.JobError):
            tj.clean_params("include", {"branch": protected, "target": "existing", "confirm_push": True})
    assert tj.clean_params("include", {"branch": "main", "target": "new"})[0]["target"] == "new"   # a new branch from main is fine
    with pytest.raises(tj.JobError):
        tj.clean_params("include", {"branch": "x", "target": "sideways"})

    for dt in ("DT-50", "DT-51"):
        run(dt, "generate", "generated", {"testcases": ["TC_1_A.py"]})
        run(dt, "validate", "yes", {"remaining": []}, device_id="123456", device_password="pw",
            unfixed_device_id="654321", unfixed_device_password="pw")
    first = tj.create_job("DT-50", "include", ok, "Giri")
    with pytest.raises(tj.JobError) as e:                                               # same branch, other ticket, while the first is open
        tj.create_job("DT-51", "include", ok, "Giri")
    assert e.value.status == 409 and "DT-50" in str(e.value)
    assert tj.create_job("DT-51", "include", {**ok, "branch": "another_branch"}, "Giri")["status"] == "queued"   # other branch is fine
    tj.claim("w1"); tj.finish(first["id"], "w1", "done", "pushed", "ok", {"branch": ok["branch"], "commit": "a" * 40})


def test_push_into_an_existing_branch_is_checked_against_the_remote(monkeypatch, tmp_path):
    out = tmp_path / "out" / "DT-60"; out.mkdir(parents=True)
    (out / "bug_analysis.json").write_text(json.dumps({"device_validation": {"x": 1}}))
    job = {"dt": "DT-60", "stage": "include", "params": {"branch": "qa", "target": "existing"}}
    sha, old = "b" * 40, "a" * 40
    monkeypatch.setattr(tw, "branch_on_origin", lambda repo, b, commit="": commit == sha)
    monkeypatch.setattr(tw, "check_push_into", lambda repo, before, commit: None)
    good = {"outcome": "pushed", "branch": "qa", "commit": sha, "summary": "added"}
    assert tw.verify(tmp_path, job, good, {"remote_sha": old})[:2] == ("done", "pushed")
    assert tw.verify(tmp_path, job, {**good, "branch": "other"}, {"remote_sha": old})[0] == "failed"      # a different branch
    assert tw.verify(tmp_path, job, {**good, "commit": ""}, {"remote_sha": old})[0] == "failed"           # no commit reported
    assert tw.verify(tmp_path, job, {**good, "commit": "c" * 40}, {"remote_sha": old})[0] == "failed"     # remote is elsewhere
    monkeypatch.setattr(tw, "check_push_into", lambda repo, before, commit: "history was rewritten.")
    st, _, msg, _ = tw.verify(tmp_path, job, good, {"remote_sha": old})
    assert st == "failed" and "HAS happened" in msg


def test_push_into_checks_history_and_touched_files_in_a_real_repo(tmp_path):
    import subprocess
    def g(*a):
        return subprocess.run(["git", *a], cwd=tmp_path, capture_output=True, text=True, check=True).stdout.strip()
    g("init", "-q", "-b", "qa"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
    d = tmp_path / "Test_Automation_Framework" / "src" / "test_cases" / "X"; d.mkdir(parents=True)
    (tmp_path / "Test_Automation_Framework" / "main_db.xlsx").write_text("db0"); (tmp_path / "keep.txt").write_text("k")
    g("add", "."); g("commit", "-qm", "base"); old = g("rev-parse", "HEAD")
    (d / "TC_1_X.py").write_text("t"); (tmp_path / "Test_Automation_Framework" / "main_db.xlsx").write_text("db1")
    g("add", "."); g("commit", "-qm", "add"); good = g("rev-parse", "HEAD")
    assert tw.check_push_into(tmp_path, old, good) is None
    (tmp_path / "keep.txt").write_text("changed"); g("add", "."); g("commit", "-qm", "sneaky"); bad = g("rev-parse", "HEAD")
    assert "keep.txt" in tw.check_push_into(tmp_path, old, bad)
    g("checkout", "-q", "-b", "other", old); (tmp_path / "z.txt").write_text("z"); g("add", "."); g("commit", "-qm", "rewrite")
    assert "rewritten" in tw.check_push_into(tmp_path, good, g("rev-parse", "HEAD"))
    assert tw.check_push_into(tmp_path, "", good) is None and tw.check_push_into(tmp_path, good, good) is None


def _repo_with_included_testcases(tmp_path):
    """A local bare 'origin', a nd_test_bot clone, and a branch 'qa' holding two tickets' testcases."""
    import subprocess, openpyxl
    root = tmp_path / "proj"
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "qa", str(origin)], check=True)
    repo = root / "repos" / "nd_test_bot"
    repo.parent.mkdir(parents=True)
    subprocess.run(["git", "clone", "-q", str(origin), str(repo)], check=True, capture_output=True)
    def g(*a, cwd=repo):
        return subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()
    g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("checkout", "-q", "-b", "qa")
    tf = repo / "Test_Automation_Framework"
    (tf / "src" / "test_cases" / "BAG").mkdir(parents=True)
    (tf / "src" / "test_cases" / "BAG" / "TC_1_BAG_OTHER.py").write_text("keep me")
    (tf / "src" / "test_cases" / "BAG" / "TC_7_BAG_MINE.py").write_text("remove me")
    (tf / "src" / "test_cases" / "BAG" / "TC_8_BAG_MINE_TOO.py").write_text("remove me too")
    wb = openpyxl.Workbook(); ws = wb.active
    ws.append(["file_name", "description", "Remark"])
    for n in ("TC_1_BAG_OTHER.py", "TC_7_BAG_MINE.py", "TC_8_BAG_MINE_TOO.py"):
        ws.append([n, "d", "candidate, pending review"])
    wb.save(tf / "main_db.xlsx")
    g("add", "."); g("commit", "-qm", "included"); g("push", "-q", "origin", "qa")
    (root / ".venv" / "bin").mkdir(parents=True)
    wrapper = root / ".venv" / "bin" / "python3"      # a wrapper, so the venv that has openpyxl is the one that runs
    wrapper.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n'); wrapper.chmod(0o755)
    out = root / "out" / "DT-70"; out.mkdir(parents=True)
    (out / "TC_7_BAG_MINE.py").write_text("remove me"); (out / "TC_8_BAG_MINE_TOO.py").write_text("remove me too")
    (out / "bug_analysis.json").write_text(json.dumps({"jira_tc_subtasks": [{"testcase_file": "TC_9_BAG_OLD_NAME.py"}]}))
    return root, repo, origin, g


def test_remove_takes_the_testcases_out_of_a_branch_with_one_plain_commit(tmp_path):
    import subprocess, openpyxl
    root, repo, origin, g = _repo_with_included_testcases(tmp_path)
    notes = []
    job = {"id": "r" * 32, "dt": "DT-70", "stage": "remove", "params": {"branch": "qa"}}
    before = subprocess.run(["git", "rev-parse", "qa"], cwd=origin, capture_output=True, text=True).stdout.strip()
    st, oc, msg, res = tw.remove_from_branch(root, job, notes.append)
    assert (st, oc) == ("done", "removed"), msg
    assert res["removed_rows"] == 2 and len(res["removed_files"]) == 2
    after = subprocess.run(["git", "rev-parse", "qa"], cwd=origin, capture_output=True, text=True).stdout.strip()
    assert after == res["commit"] != before
    assert subprocess.run(["git", "merge-base", "--is-ancestor", before, after], cwd=origin).returncode == 0   # history kept
    files = subprocess.run(["git", "ls-tree", "-r", "--name-only", "qa"], cwd=origin, capture_output=True, text=True).stdout
    assert "TC_1_BAG_OTHER.py" in files and "TC_7_BAG_MINE.py" not in files and "TC_8_BAG_MINE_TOO.py" not in files
    subprocess.run(["git", "--git-dir", str(origin), "show", "qa:Test_Automation_Framework/main_db.xlsx"], stdout=open(tmp_path / "db.xlsx", "wb"), check=True)
    rows = [r[0] for r in openpyxl.load_workbook(tmp_path / "db.xlsx").active.iter_rows(min_row=2, values_only=True)]
    assert rows == ["TC_1_BAG_OTHER.py"]
    assert "remove regression testcase" in subprocess.run(["git", "log", "-1", "--format=%s", "qa"], cwd=origin, capture_output=True, text=True).stdout
    assert not (root / "out" / "DT-70" / ".dashboard" / ("wt_rm_" + "r" * 32)).exists()      # work area cleaned up
    assert notes
    # again: nothing left to remove
    st, oc, msg, _ = tw.remove_from_branch(root, {**job, "id": "s" * 32}, notes.append)
    assert (st, oc) == ("done", "absent") and "nothing to remove" in msg
    # a branch that is not on the remote
    st, _, msg, _ = tw.remove_from_branch(root, {**job, "id": "t" * 32, "params": {"branch": "nope"}}, notes.append)
    assert st == "failed" and "not found" in msg


def test_remove_job_flow_and_gates_in_the_backend():
    run("DT-71", "generate", "generated", {"testcases": ["TC_1_A.py"]})
    run("DT-71", "validate", "yes", {"remaining": []}, device_id="123456", device_password="pw", unfixed_device_id="654321", unfixed_device_password="pw")
    ok = {"branch": "qa", "confirm_remove": True}
    with pytest.raises(tj.JobError) as e:
        tj.create_job("DT-71", "remove", ok, "Giri")                      # not listed in Included in runs
    assert e.value.status == 409
    run("DT-71", "include", "pushed", {"branch": "qa", "commit": "a" * 40}, branch="qa", target="existing", confirm_push=True)
    assert cell("DT-71", "included_in_runs") == "qa"
    with pytest.raises(tj.JobError):
        tj.create_job("DT-71", "remove", {"branch": "qa"}, "Giri")        # no confirmation
    with pytest.raises(tj.JobError):
        tj.create_job("DT-71", "remove", {"branch": "main", "confirm_remove": True}, "Giri")
    job = tj.create_job("DT-71", "remove", ok, "Giri")
    tj.claim("w1"); tj.finish(job["id"], "w1", "done", "removed", "ok", {"branch": "qa", "commit": "b" * 40})
    assert cell("DT-71", "included_in_runs") == ""                         # the branch is gone from the cell...
    assert cell("DT-71", "validated") == "Yes" and cell("DT-71", "generated_tcs") == "Yes"   # ...the ticket stays validated
    with pytest.raises(tj.JobError):
        tj.finish(job["id"], "w1", "done", "removed", "again", {})         # not running any more


def _three_testcases(tmp_path, dt="DT-80"):
    out = tmp_path / "out" / dt; out.mkdir(parents=True)
    for n in ("TC_5667_A.py", "TC_5680_B.py", "TC_5681_C.py"):
        (out / n).write_text(n)
    (out / "bug_analysis.json").write_text(json.dumps({"device_validation": {"x": 1}}))
    return out


def test_each_testcase_has_its_own_validation_status(tmp_path):
    out = _three_testcases(tmp_path)
    fixed = {"id": "j1", "dt": "DT-80", "stage": "validate", "params": {"mode": "fixed", "device_id": "111111"}}
    res = {"outcome": "partial", "testcases": ["TC_5667_A.py", "TC_5680_B.py", "TC_5681_C.py"],
           "testcase_results": [{"testcase": "TC_5667_A.py", "fixed_result": "pass"},
                                {"testcase": "TC_5680_B.py", "fixed_result": "na"},
                                {"testcase": "TC_5681", "fixed_result": "na"}]}          # matched by TC id too
    st, oc, _, final = tw.verify(tmp_path, fixed, res)
    assert (st, oc) == ("done", "partial")
    assert final["testcase_status"] == {"TC_5667_A.py": "partial", "TC_5680_B.py": "na", "TC_5681_C.py": "na"}
    assert any(r.startswith("TC_5680: reported NA") for r in final["remaining"]) and any(r.startswith("TC_5667: passed with the fix") for r in final["remaining"])
    tw.commit_validation_state(tmp_path, fixed, final)
    view = tw.validation_view(tmp_path, "DT-80")
    assert view["TC_5667_A.py"] == {"status": "partial", "fixed_device": "111111", "unfixed_device": ""}
    assert view["TC_5680_B.py"]["status"] == "na"
    # the unfixed side for ONLY the first testcase: it becomes fully validated, the ticket does not
    unf = {"id": "j2", "dt": "DT-80", "stage": "validate", "params": {"mode": "unfixed", "unfixed_device_id": "222222"}}
    st, oc, _, final = tw.verify(tmp_path, unf, {"outcome": "partial", "testcases": ["TC_5667_A.py"], "unfixed_result": "fail"})
    assert final["testcase_status"]["TC_5667_A.py"] == "yes" and oc == "partial"      # two testcases still open
    tw.commit_validation_state(tmp_path, unf, final)
    assert tw.validation_view(tmp_path, "DT-80")["TC_5667_A.py"] == {"status": "yes", "fixed_device": "111111", "unfixed_device": "222222"}
    # a testcase that fails with the fix is failed, and the ticket is No
    both = {"id": "j3", "dt": "DT-80", "stage": "validate", "params": {"mode": "both", "device_id": "111111", "unfixed_device_id": "222222"}}
    st, oc, _, final = tw.verify(tmp_path, both, {"outcome": "yes", "testcases": ["TC_5680_B.py"],
                                                  "testcase_results": [{"testcase": "TC_5680_B.py", "fixed_result": "fail", "unfixed_result": "fail"}]})
    assert oc == "no" and final["testcase_status"]["TC_5680_B.py"] == "failed"
    # every testcase done on both sides: Yes, and nothing is left
    for n in ("TC_5680_B.py", "TC_5681_C.py"):
        r = {"outcome": "yes", "testcases": [n], "testcase_results": [{"testcase": n, "fixed_result": "pass", "unfixed_result": "fail"}]}
        st, oc, _, final = tw.verify(tmp_path, both, r)
        tw.commit_validation_state(tmp_path, both, final)
    assert oc == "yes" and final["remaining"] == [] and set(final["testcase_status"].values()) == {"yes"}
    # editing one file drops only its evidence
    (out / "TC_5681_C.py").write_text("edited")
    assert {n: v["status"] for n, v in tw.validation_view(tmp_path, "DT-80").items()} == {
        "TC_5667_A.py": "yes", "TC_5680_B.py": "yes", "TC_5681_C.py": "not_run"}
    # renaming (the Jira TC id) keeps the evidence
    (out / "TC_5667_A.py").rename(out / "TC_9999_A.py")
    assert tw.validation_view(tmp_path, "DT-80")["TC_9999_A.py"]["status"] == "yes"


def test_older_ticket_wide_state_is_migrated_for_a_single_testcase(tmp_path):
    import hashlib
    out = tmp_path / "out" / "DT-81"; (out / ".dashboard").mkdir(parents=True)
    (out / "TC_1_A.py").write_text("x")
    h = hashlib.sha256(b"x").hexdigest()
    (out / ".dashboard" / "validation_state.json").write_text(json.dumps(
        {"sha": hashlib.sha256(h.encode()).hexdigest(), "fixed": {"device": "1", "job": "j"}, "unfixed": {"device": "2", "job": "j"}}))
    assert tw.validation_view(tmp_path, "DT-81")["TC_1_A.py"]["status"] == "yes"
    (out / "TC_2_B.py").write_text("y")                  # two testcases now: the ticket-wide record proves nothing per file
    assert {v["status"] for v in tw.validation_view(tmp_path, "DT-81").values()} == {"not_run"}


def test_validation_per_testcase_is_stored_for_the_page():
    n = tj.set_requirements({"DT-90": {"testcases": ["TC_1_A.py"], "validation": {
        "TC_1_A.py": {"status": "yes", "fixed_device": "111111", "unfixed_device": "222222"},
        "evil.sh": {"status": "yes"}, "TC_2_B.py": {"status": "wat"}}}})
    v = tj.overview()["requirements"]["DT-90"]["validation"]
    assert v["TC_1_A.py"]["status"] == "yes" and v["TC_2_B.py"]["status"] == "not_run" and "evil.sh" not in v


def test_unfixed_failure_for_the_wrong_reason_proves_nothing():
    names = ["TC_1_A.py", "TC_2_B.py"]
    params = {"mode": "both", "device_id": "111111", "unfixed_device_id": "222222"}
    result = {"fixed_result": "pass", "unfixed_result": "fail", "testcase_results": [
        {"testcase": "TC_1_A.py", "fixed_result": "pass", "unfixed_result": "fail", "unfixed_conclusive": True},
        {"testcase": "TC_2_B.py", "fixed_result": "pass", "unfixed_result": "fail", "unfixed_conclusive": False}]}
    s = tw.testcase_sides(params, result, "partial", names)
    assert s["TC_1_A.py"] == ("pass", "fail") and s["TC_2_B.py"] == ("pass", "na")
    # run-wide flag false: not counted; "device" as a reason alone (e.g. no fixed device in the run) must NOT discount a failure
    r2 = {"fixed_result": "pass", "unfixed_result": "fail", "unfixed_conclusive": False}
    assert tw.testcase_sides(params, r2, "partial", names)["TC_1_A.py"] == ("pass", "na")
    r3 = {"fixed_result": "pass", "unfixed_result": "fail", "reason_category": "device"}
    assert tw.testcase_sides(params, r3, "partial", names)["TC_1_A.py"] == ("pass", "fail")
    only_unfixed = {"unfixed_result": "fail", "reason_category": "device"}                    # DT-5507's run
    assert tw.testcase_sides({"mode": "unfixed", "unfixed_device_id": "222222"}, only_unfixed, "partial", ["TC_1_A.py"])["TC_1_A.py"] == ("", "fail")
    # a clean yes run still counts
    assert tw.testcase_sides(params, {"fixed_result": "pass", "unfixed_result": "fail"}, "yes", names)["TC_1_A.py"] == ("pass", "fail")


def test_device_check_commands_must_be_read_only():
    ok = tw.safe_check_command
    assert ok("grep -c '\\[health_central\\]' /home/ubuntu/.nddevice/latest/bagheera_config.ini")
    assert ok("systemctl is-active health_central") and ok("cat /etc/hostname | head -1") and ok("dpkg -s nd-device")
    for bad in ("rm -rf /", "cat x > y", "ls; reboot", "cat x && reboot", "systemctl restart bagheera",
                "echo $(reboot)", "sudo cat x", "sed -i s/a/b/ f", "awk 'BEGIN{system(\"x\")}'", "dpkg -i x.deb", "cat `id`", ""):
        assert not ok(bad), bad


CHECKS = [{"what": "installed config has [health_central]", "command": "grep -c health_central /x.ini", "match": "^[1-9]",
           "fixed": "match", "unfixed": "nomatch"},
          {"what": "service exists", "command": "systemctl is-active health_central", "match": "^active",
           "fixed": "match", "unfixed": "match"}]


def test_fix_checks_are_cleaned_and_judged_per_role(tmp_path):
    d = tmp_path / "out" / "DT-1"
    d.mkdir(parents=True)
    bad = {"what": "x", "command": "rm -rf /", "match": "x", "fixed": "match"}
    (d / "bug_analysis.json").write_text(json.dumps({"validation_requirements": {"fix_checks": CHECKS + [bad]}}))
    checks = tw.fix_checks(tmp_path, "DT-1")
    assert [c["what"] for c in checks] == [CHECKS[0]["what"], CHECKS[1]["what"]]      # the unsafe one is dropped
    has_fix = [{"rc": 0, "out": "2\n"}, {"rc": 0, "out": "active\n"}]
    no_fix = [{"rc": 1, "out": "0\n"}, {"rc": 3, "out": "inactive\n"}]
    req = {"fixed_build": "PR 3663", "unfixed_build": "before PR 3663"}
    assert tw.judge_checks(checks, "fixed", has_fix, "Device", "111111", req) is None
    msg = tw.judge_checks(checks, "fixed", no_fix, "Device", "111111", req)
    assert "does not have the fix" in msg and "PR 3663" in msg
    msg = tw.judge_checks(checks, "unfixed", has_fix, "Unfixed device", "222222", req)
    assert "already has the fix" in msg
    # without the fix but also without the service: wrong device for the unfixed role
    msg = tw.judge_checks(checks, "unfixed", no_fix, "Unfixed device", "222222", req)
    assert "not set up" in msg and "service exists" in msg
    assert tw.judge_checks(checks, "unfixed", [{"rc": 1, "out": "0\n"}, {"rc": 0, "out": "active\n"}], "U", "2", req) is None


def test_device_state_problem_login_and_unreachable(tmp_path, monkeypatch):
    info = {"device_ip": "1.2.3.4", "ssh_username": "root"}
    chk = [dict(c) for c in CHECKS]
    monkeypatch.setattr(tw, "run_device_checks", lambda *a: {"error": "login", "detail": "x"})
    assert "password was not accepted" in tw.device_state_problem(tmp_path, info, "pw", "fixed", "Device", "1", {}, chk)
    monkeypatch.setattr(tw, "run_device_checks", lambda *a: {"error": "connect", "detail": "x"})
    assert tw.device_state_problem(tmp_path, info, "pw", "fixed", "Device", "1", {}, chk) is None   # not a verdict
    assert tw.device_state_problem(tmp_path, info, "pw", "fixed", "Device", "1", {}, []) is None


def test_skip_device_checks_param_is_kept():
    p, _ = tj.clean_params("validate", {"mode": "fixed", "device_id": "123456", "device_password": "x", "skip_device_checks": True})
    assert p["skip_device_checks"] == "1"
    p, _ = tj.clean_params("validate", {"mode": "fixed", "device_id": "123456", "device_password": "x"})
    assert "skip_device_checks" not in p


def test_detect_device_output_is_parsed_whether_indented_or_one_line():
    pretty = '{\n  "device_id": "1",\n  "device_type": "krait",\n  "device_ip": "1.2.3.4",\n  "ssh_username": "root"\n}\n'
    assert tw.parse_device_info(pretty)["device_ip"] == "1.2.3.4"
    assert tw.parse_device_info('{"error": "x"}\n')["error"] == "x"
    assert tw.parse_device_info("warning\n{\"a\": 1}")["a"] == 1
    assert tw.parse_device_info("not json") is None


def test_include_new_branch_custom_name_is_validated_and_kept():
    base = {"stage": "include", "branch": "6.17_qa", "target": "new"}
    p, _ = tj.clean_params("include", {"branch": "6.17_qa", "target": "new", "new_branch": "my/own-name"})
    assert p == {"branch": "6.17_qa", "target": "new", "new_branch": "my/own-name"}
    p, _ = tj.clean_params("include", {"branch": "6.17_qa", "target": "new"})
    assert "new_branch" not in p                                                    # generated name
    for bad in ("main", "origin/master", "6.17_qa", "bad name", "a..b"):
        with pytest.raises(tj.JobError):
            tj.clean_params("include", {"branch": "6.17_qa", "target": "new", "new_branch": bad})
    p, _ = tj.clean_params("include", {"branch": "6.17_qa", "target": "existing", "confirm_push": True, "new_branch": "x"})
    assert "new_branch" not in p                                                    # only for a new branch


def test_include_new_branch_prompt_and_result_check(tmp_path, monkeypatch):
    job = {"dt": "DT-1", "stage": "include", "id": "j1", "params": {"branch": "6.17_qa", "target": "new", "new_branch": "my-name"}}
    prompt = tw.build_prompt(job, tmp_path / "r.json")
    assert "base-branch=6.17_qa new-branch=my-name" in prompt and "do not add a suffix" in prompt
    plain = dict(job, params={"branch": "6.17_qa", "target": "new"})
    assert "new-branch=" not in tw.build_prompt(plain, tmp_path / "r.json")
    monkeypatch.setattr(tw, "branch_on_origin", lambda *a, **k: True)
    r = {"outcome": "pushed", "branch": "bugreg/DT-1-on-6.17_qa", "commit": "a" * 40, "summary": "x"}
    st, _, msg, _ = tw.verify(tmp_path, job, r)
    assert st == "failed" and "my-name" in msg                                       # asked for a name, got another
    assert tw.verify(tmp_path, job, dict(r, branch="my-name"))[0] == "done"
    assert tw.verify(tmp_path, plain, r)[0] == "done"                                # generated name: any valid branch


def test_generate_and_regenerate_prompts_say_how_to_read_a_pr_without_the_api(tmp_path):
    for stage in ("generate", "regenerate"):
        prompt = tw.build_prompt({"dt": "DT-1", "stage": stage, "id": "j", "params": {}}, tmp_path / "r.json")
        assert "refs/pull/<number>/head" in prompt and "is-ancestor" in prompt
    val = tw.build_prompt({"dt": "DT-1", "stage": "validate", "id": "j", "params": {"mode": "fixed", "device_id": "123456"}}, tmp_path / "r.json")
    assert "refs/pull/" not in val                     # only where PRs are read


def test_fix_checks_drop_grep_rc_on_a_folder_but_keep_single_file_counts(tmp_path):
    d = tmp_path / "out" / "DT-2"
    d.mkdir(parents=True)
    checks = [
        {"what": "bad", "command": "grep -rc 'x' /home/ubuntu/dir/", "match": "[1-9]", "fixed": "match", "unfixed": "nomatch"},
        {"what": "bad2", "command": "grep -cr x /dir", "match": "^[1-9]", "fixed": "match", "unfixed": "nomatch"},
        {"what": "ok file", "command": "grep -c x /dir/f.ini", "match": "^[1-9]", "fixed": "match", "unfixed": "nomatch"},
        {"what": "ok folder", "command": "grep -rl x /dir | wc -l", "match": "^[1-9]", "fixed": "match", "unfixed": "nomatch"}]
    (d / "bug_analysis.json").write_text(json.dumps({"validation_requirements": {"fix_checks": checks}}))
    assert [c["what"] for c in tw.fix_checks(tmp_path, "DT-2")] == ["ok file", "ok folder"]
    prompt = tw.build_prompt({"dt": "DT-2", "stage": "generate", "id": "j", "params": {}}, tmp_path / "r.json")
    assert "Never `grep -rc` on a folder" in prompt


def test_device_caused_failure_is_inconclusive_not_failed(tmp_path):
    d = tmp_path / "out" / "DT-9"
    d.mkdir(parents=True)
    (d / "TC_1_A.py").write_text("a")
    (d / "TC_2_B.py").write_text("b")
    job = {"dt": "DT-9", "id": "j1", "params": {"mode": "fixed", "device_id": "123456"}}
    res = {"outcome": "no", "fixed_result": "fail", "reason_category": "device", "reason": "no DHUB attached",
           "testcases": ["TC_1_A.py", "TC_2_B.py"]}
    final, extra = tw.judge_validation(tmp_path, job, res, "no")
    assert final == "inconclusive" and extra["fixed_result"] == "na"
    assert set(extra["testcase_status"].values()) == {"na"}                       # not "failed"
    assert any("no DHUB attached" in x for x in tw.remaining_items(tmp_path, "DT-9", job["params"], dict(res, **extra), final))
    # the same failure blamed on the testcase is still a failure
    final, extra = tw.judge_validation(tmp_path, job, dict(res, reason_category="testcase"), "no")
    assert final == "no" and set(extra["testcase_status"].values()) == {"failed"}


def test_both_halves_on_record_lift_a_half_run_partial_to_yes(tmp_path):
    d = tmp_path / "out" / "DT-8"
    d.mkdir(parents=True)
    f = d / "TC_1_A.py"
    f.write_text("a")
    job1 = {"dt": "DT-8", "id": "j1", "params": {"mode": "unfixed", "unfixed_device_id": "222222"}}
    res1 = {"outcome": "partial", "unfixed_result": "fail", "unfixed_conclusive": True, "testcases": ["TC_1_A.py"]}
    final, extra = tw.judge_validation(tmp_path, job1, res1, "partial")
    tw.commit_validation_state(tmp_path, job1, dict(res1, **extra))
    job2 = {"dt": "DT-8", "id": "j2", "params": {"mode": "fixed", "device_id": "111111"}}
    res2 = {"outcome": "partial", "fixed_result": "pass", "reason_category": "device", "testcases": ["TC_1_A.py"]}
    assert tw.judge_validation(tmp_path, job2, res2, "partial")[0] == "yes"
    # a partial blamed on the testcase or the product is never lifted
    assert tw.judge_validation(tmp_path, job2, dict(res2, reason_category="testcase"), "partial")[0] == "partial"
