"""Unit tests for the build log: Octo scr.js parsing and the job-aware table (no network)."""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import build_log as bl  # noqa: E402
import database as db  # noqa: E402

SCRJS = (
    b'const data = [\n{ _id: "x", file_name: "TC_1.py", note: "has ]; inside" }\n];\n'
    b'const device_ids = ["2", "1"];\n'
    b'const row = [\n'
    b'  {"Serial_Number": "2", "Product_Type": "D810", "OS_Version": "15.0.9",'
    b'   "OTA_Version": "810.1", "Ip_Address": "10.0.0.2", "Start_Timestamp": "2026-11-11 19:39:31",'
    b'   "total_count": 329, "pass_count": 283, "fail_count": 23, "NE_count": 7, "NA_count": 16},\n'
    b'  {"Serial_Number": "1", "Product_Type": "D810", "OS_Version": "15.0.9",'
    b'   "OTA_Version": "810.1", "Ip_Address": "10.0.0.1", "Start_Timestamp": "2026-11-11 19:39:29",'
    b'   "total_count": 415, "pass_count": 363, "fail_count": 41, "NE_count": 0, "NA_count": 11}\n'
    b'];\nconst main_output = {"test_ids": ["never read"]};\n'
)


def _chunks(data: bytes, size: int):
    for i in range(0, len(data), size):
        yield data[i:i + size]


@pytest.mark.parametrize("size", [1, 7, 64, 10_000])
def test_scrjs_rows_found_across_any_chunking(size):
    rows = bl.read_scrjs_rows(_chunks(SCRJS, size))
    assert [r["Serial_Number"] for r in rows] == ["2", "1"]


def test_scrjs_stops_reading_after_row_block():
    consumed = []

    def tracked():
        for c in _chunks(SCRJS + b"x" * 10_000_000, 4096):
            consumed.append(len(c))
            yield c

    assert bl.read_scrjs_rows(tracked())
    assert sum(consumed) < len(SCRJS) + 4096


def test_scrjs_without_row_block():
    assert bl.read_scrjs_rows(_chunks(b"const data = [];\n", 5)) is None


def test_parse_scrjs_rows_matches_overall_summary_shape():
    devices = bl.parse_scrjs_rows(bl.read_scrjs_rows(_chunks(SCRJS, 100)))
    assert [d["device_id"] for d in devices] == ["1", "2"]
    d = devices[1]
    assert (d["sku"], d["package"], d["pass"], d["fail"], d["not_executed"], d["not_applicable"]) == (
        "D810", "810.1", 283, 23, 7, 16)
    assert d["pass_pct"] == round(283 / (283 + 23 + 7) * 100, 2)


def test_octo_services_only_enabled_setups():
    params = {
        "Enable_Setup_01": True, "Setup_01_Devices": "1", "Setup_01_Services": "SANITY2, APM",
        "Enable_Setup_02": True, "Setup_02_Devices": "2,3", "Setup_02_Services": "SPEED",
        "Enable_Setup_03": False, "Setup_03_Devices": "9", "Setup_03_Services": "X",
    }
    assert bl.octo_services(params) == {"1": ["SANITY2", "APM"], "2": ["SPEED"], "3": ["SPEED"]}


def _record(job, number, **kw):
    rec = {
        "job": job, "build_number": number, "built_at": f"2026-11-1{number % 10}T00:00:00+00:00",
        "duration_sec": 1, "suite": "", "product": "", "packages": [], "devices": [],
        "pass_count": 1, "fail_count": 0, "ne_count": 0, "na_count": 0,
        "known_count": 0, "unknown_count": 0, "pass_pct": 100.0, "known_pct": 0.0,
        "unknown_pct": 0.0, "build_url": "", "report_url": "",
    }
    rec.update(kw)
    return rec


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    return tmp_path / "t.db"


def test_same_build_number_in_both_jobs(tmp_db):
    db.init_db()
    db.save_logged_build(_record("daily", 476))
    db.save_logged_build(_record("octo", 476, known_count=None))
    assert db.get_logged_build_numbers("daily") == {476}
    assert db.get_logged_build_numbers("octo") == {476}
    assert db.get_logged_builds_needing_retry("daily") == []
    assert db.get_logged_builds_needing_retry("octo") == [476]
    rows, total = db.get_logged_builds(filters={"job": "octo"})
    assert total == 1 and rows[0]["job"] == "octo"
    assert db.get_logged_builds()[1] == 2


def test_migrates_pre_job_table(tmp_db):
    conn = sqlite3.connect(tmp_db)
    conn.execute(
        "CREATE TABLE build_log (build_number INTEGER PRIMARY KEY, built_at TEXT NOT NULL DEFAULT '', "
        "duration_sec INTEGER NOT NULL DEFAULT 0, suite TEXT NOT NULL DEFAULT '', product TEXT NOT NULL DEFAULT '', "
        "packages_json TEXT NOT NULL DEFAULT '[]', devices_json TEXT NOT NULL DEFAULT '[]', "
        "pass_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0, "
        "ne_count INTEGER NOT NULL DEFAULT 0, na_count INTEGER NOT NULL DEFAULT 0, known_count INTEGER, "
        "unknown_count INTEGER, pass_pct REAL NOT NULL DEFAULT 0, known_pct REAL, unknown_pct REAL, "
        "build_url TEXT NOT NULL DEFAULT '', report_url TEXT NOT NULL DEFAULT '', "
        "logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    conn.execute("INSERT INTO build_log (build_number, pass_pct, suite) VALUES (5120, 91.5, 'Regression')")
    conn.commit()
    conn.close()

    db.init_db()
    db.init_db()  # second worker starting: no-op
    rows, total = db.get_logged_builds()
    assert total == 1
    assert (rows[0]["job"], rows[0]["build_number"], rows[0]["pass_pct"], rows[0]["suite"]) == (
        "daily", 5120, 91.5, "Regression")
    db.save_logged_build(_record("octo", 5120))
    assert db.get_logged_builds()[1] == 2


def test_only_one_sync_across_processes(tmp_path, monkeypatch):
    monkeypatch.setattr(bl, "_STATE_DIR", tmp_path)
    monkeypatch.setattr(bl, "_LOCK_FILE", tmp_path / "l.lock")
    monkeypatch.setattr(bl, "_PROGRESS_FILE", tmp_path / "p.json")
    held = bl._try_file_lock()  # stands in for another worker's sync
    try:
        assert bl.get_sync_status()["running"] is True
        assert bl.sync_builds(lambda: None)["busy"] is True
    finally:
        bl._release_file_lock(held)
    assert bl.get_sync_status()["running"] is False
