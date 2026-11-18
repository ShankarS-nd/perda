"""Tests for relay_ops with a stub relayctl.py (nothing real is switched)."""
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import relay_ops as ro  # noqa: E402

STUB = '''
import sys, time
print("ARGS", " ".join(sys.argv[1:]))
if "slow" in sys.argv: time.sleep(2)
sys.exit(3 if "fail" in sys.argv else 0)
'''


@pytest.fixture(autouse=True)
def stub(tmp_path, monkeypatch):
    (tmp_path / "relayctl.py").write_text(STUB)
    monkeypatch.setattr(ro, "RELAYCTL_DIR", tmp_path)
    monkeypatch.setattr(ro, "RELAYCTL_PY", tmp_path / "relayctl.py")
    monkeypatch.setattr(ro, "RELAYCTL_LOG", tmp_path / "relayctl.log")
    monkeypatch.setattr(ro, "JOB_LOG_DIR", tmp_path / "jobs")


def wait(job_id, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        v = ro.get_job(job_id)
        if v["state"] != "running":
            return v
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_check_accepts_mixed_separators_and_dedupes():
    argv, toks = ro.build_argv("check", ["6603083402, 6603083306", "[6603083402]\n103412400067"], False, False)
    assert toks == ["6603083402", "6603083306", "103412400067"]
    assert argv[3:] == ["check", *toks]


def test_read_only_never_gets_yes_or_force():
    argv, _ = ro.build_argv("check", ["b1"], False, True)
    assert "--yes" not in argv and "--force" not in argv


def test_switching_flags():
    assert ro.build_argv("wake", ["b1"], True, False)[0][-1] == "--dry-run"
    live = ro.build_argv("restart-device", ["b1"], False, False)[0]
    assert live[3:6] == ["restart", "device", "b1"] and live[-1] == "--yes"
    assert ro.build_argv("wake", ["b1"], False, True)[0][-2:] == ["--yes", "--force"]
    # force is ignored on a dry run
    assert "--force" not in ro.build_argv("wake", ["b1"], True, True)[0]


@pytest.mark.parametrize("cmd,targets", [
    ("wake", []), ("wake", ["a", "b"]), ("check", []), ("discover", ["x"]),
    ("pi-check", ["a", "b"]), ("boards", ["a", "b"]),
    ("nope", ["a"]), ("check", ["a; rm -rf /"]), ("check", ["$(id)"]), ("check", ["--yes"]),
])
def test_bad_requests_rejected(cmd, targets):
    with pytest.raises(ro.RelayError) as e:
        ro.build_argv(cmd, targets, False, False)
    assert e.value.status == 400


def test_switching_needs_confirmation_but_dry_run_does_not():
    with pytest.raises(ro.RelayError, match="confirm"):
        ro.start_job("wake", ["b1"], dry_run=False, confirmed=False, force=False)
    v = wait(ro.start_job("wake", ["b1"], dry_run=True, confirmed=False, force=False)["id"])
    assert v["state"] == "done" and "--dry-run" in v["lines"][0] and "--yes" not in v["lines"][0]


def test_job_streams_output_and_reports_exit_code():
    v = wait(ro.start_job("check", ["b1", "fail"], False, False, False)["id"])
    assert v["state"] == "failed" and v["exit_code"] == 3
    assert v["lines"] == ["ARGS check b1 fail"]
    assert ro.get_job(v["id"], after=v["next"])["lines"] == []


def test_same_bench_cannot_be_switched_twice():
    first = ro.start_job("wake", ["slow"], False, True, False)
    assert first["state"] == "running"
    with pytest.raises(ro.RelayError) as e:
        ro.start_job("restart-device", ["slow"], False, True, False)
    assert e.value.status == 409
    wait(first["id"])
    wait(ro.start_job("wake", ["slow"], False, True, False)["id"])  # free again


def test_missing_relayctl(monkeypatch, tmp_path):
    monkeypatch.setattr(ro, "RELAYCTL_PY", tmp_path / "missing.py")
    with pytest.raises(ro.RelayError) as e:
        ro.start_job("check", ["b1"], False, False, False)
    assert e.value.status == 503 and ro.config()["available"] is False


def test_audit_tail(tmp_path):
    assert ro.audit_tail() == []
    (tmp_path / "relayctl.log").write_text("\n".join(f"l{i}" for i in range(100)) + "\n")
    assert ro.audit_tail(3) == ["l97", "l98", "l99"]


def test_catalogue_covers_the_daily_commands():
    assert {"check", "boards", "discover", "status", "pi-benches", "wake", "restart-device",
            "pi-check", "restart-relay", "restart-pi", "recover"} <= set(ro.COMMANDS)
    assert len(ro.BENCH_GROUPS["D215"]["benches"]) == 9 and len(ro.BENCH_GROUPS["D450"]["benches"]) == 9


def test_dropdown_lists_every_command_with_relayctl_names():
    names = {c["name"] for c in ro.config()["commands"]}
    assert names == {"check", "boards", "discover", "status", "pi-benches", "pi-check", "wake",
                     "restart device", "restart relay", "restart pi", "recover"}
    for key, c in ro.COMMANDS.items():
        assert ro.command_by_option(c["option"]) == key == ro.command_by_option(c["name"])


def test_inputs_per_command():
    i = lambda k: ro.inputs_for(ro.COMMANDS[k])  # noqa: E731
    assert i("discover") == {"bench_ids": None, "pi": None, "dry_run": None, "timeout": None}
    assert i("check")["bench_ids"] == "required" and i("check")["pi"] is None
    assert i("status")["bench_ids"] == "optional"
    assert i("pi-check")["pi"] == "required" and i("pi-check")["bench_ids"] is None
    assert i("restart-relay")["bench_ids"] == i("restart-relay")["pi"] == "one of"
    assert i("restart-device") == {"bench_ids": "required", "pi": None, "dry_run": "optional", "timeout": "optional"}
    assert i("boards")["pi"] == "optional"


def test_status_without_benches_is_allowed():
    assert ro.build_argv("status", [], False, False)[0][3:] == ["status"]


def test_scripts_list_hides_internal_scripts_and_has_no_relay_script():
    import script_runner as sr
    names = {i.name for i in sr.list_scripts()}
    assert not names & {"rc_comparison", "daily_comparison", "logs_download", "relay_control"}
    assert {"broadcast_check", "keepalive_check", "delete_shadow"} <= names
    # hidden, not deleted: the backend imports rc_comparison and runs logs_download
    assert (sr.SCRIPTS_DIR / "rc_comparison.py").is_file() and (sr.SCRIPTS_DIR / "logs_download.py").is_file()


def test_timeout_override_is_clamped(monkeypatch):
    seen = []
    monkeypatch.setattr(ro.threading, "Thread", lambda target, args, daemon: type("T", (), {"start": lambda self: seen.append(args[2])})())
    ro.start_job("check", ["b1"], False, False, False, timeout=5)
    ro.start_job("check", ["b1"], False, False, False, timeout=10**6)
    assert seen == [ro.MIN_TIMEOUT, ro.MAX_TIMEOUT]


def test_restart_device_limit_cannot_cut_the_30_minute_off_hold(monkeypatch):
    """A 1800 s limit (the old UI default) would kill the job while the ignition is still OFF."""
    seen = []
    monkeypatch.setattr(ro.threading, "Thread", lambda target, args, daemon: type("T", (), {"start": lambda self: seen.append(args[2])})())
    monkeypatch.setattr(ro, "check_conflict", lambda *a, **k: None)
    ro.start_job("restart-device", ["b1"], False, True, False, timeout=1800)
    assert seen == [55 * 60]


def test_job_is_visible_to_another_worker_process(tmp_path):
    """The live backend runs 4 workers: a poll must work in a process that never started the job."""
    import subprocess, sys, json
    v = ro.start_job("check", ["b1", "slow"], False, False, False)
    code = ("import sys, json; sys.path.insert(0, %r); import relay_ops as r; r.JOB_LOG_DIR = __import__('pathlib').Path(%r);"
            "print(json.dumps(r.get_job(%r)['state']))") % (os.path.dirname(os.path.dirname(__file__)), str(ro.JOB_LOG_DIR), v["id"])
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert json.loads(out.stdout) in ("running", "done"), out.stderr
    wait(v["id"])


def test_busy_check_sees_jobs_started_by_other_workers():
    import json
    meta = {"id": "abcdef0123", "command": "wake", "label": "wake", "targets": ["bX"], "dry_run": False, "force": False,
            "switching": True, "display": "", "actor": "", "started": time.time(), "finished": None, "state": "running",
            "exit_code": None, "keys": ["bX"], "pid": os.getpid()}
    ro.JOB_LOG_DIR.mkdir(parents=True, exist_ok=True)
    (ro.JOB_LOG_DIR / "abcdef0123.json").write_text(json.dumps(meta))
    with pytest.raises(ro.RelayError) as e:
        ro.start_job("wake", ["bX"], False, True, False)
    assert e.value.status == 409


def test_job_whose_process_vanished_is_reported_lost():
    import json
    meta = {"id": "0123abcdef", "command": "check", "label": "check", "targets": ["b"], "dry_run": False, "force": False,
            "switching": False, "display": "", "actor": "", "started": time.time(), "finished": None, "state": "running",
            "exit_code": None, "keys": [], "pid": 2**22 + 12345}
    ro.JOB_LOG_DIR.mkdir(parents=True, exist_ok=True)
    (ro.JOB_LOG_DIR / "0123abcdef.json").write_text(json.dumps(meta))
    assert ro.get_job("0123abcdef")["state"] == "lost"


def test_unknown_or_malformed_job_id_is_404():
    for bad in ("nope", "../../etc/passwd", "zzzzzzzzzz"):
        with pytest.raises(ro.RelayError) as e:
            ro.get_job(bad)
        assert e.value.status == 404


def test_check_is_refused_while_a_restart_holds_the_bench():
    import json
    meta = {"id": "aaaaaaaaaa", "command": "restart-device", "label": "restart device", "targets": ["bY"], "dry_run": False,
            "force": False, "switching": True, "display": "", "actor": "", "started": time.time(), "finished": None,
            "state": "running", "exit_code": None, "keys": ["bY"], "pid": os.getpid()}
    ro.JOB_LOG_DIR.mkdir(parents=True, exist_ok=True)
    (ro.JOB_LOG_DIR / "aaaaaaaaaa.json").write_text(json.dumps(meta))
    with pytest.raises(ro.RelayError) as e:
        ro.start_job("check", ["bY"], False, False, False)
    assert e.value.status == 409 and "turn its relay ON" in e.value.message
    wait(ro.start_job("check", ["other"], False, False, False)["id"])   # other benches are fine
