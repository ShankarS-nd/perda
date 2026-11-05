"""Unit tests for Release Notes Sync (no network: HTTP is stubbed)."""
import os
import sys
from datetime import datetime, timezone
from unittest import mock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import release_sync as rs  # noqa: E402

FIXED_NOW = lambda: datetime(2026, 11, 5, 10, 0, 0, tzinfo=timezone.utc)  # noqa: E731


# ── devices ────────────────────────────────────────────────────────────────

def test_device_mapping_matches_agreed_table():
    assert rs.DEVICE_MAP["D450_US"] == "B3_US"
    assert rs.DEVICE_MAP["D450_IN"] == "B3_IN"
    assert rs.DEVICE_MAP["D215_US"] == "K2_US"
    assert rs.DEVICE_MAP["D215_IN"] == "K2_IN"
    assert rs.DEVICE_MAP["D430_US"] == "B2_US"
    assert rs.DEVICE_MAP["D210_US"] == "K1_US"
    assert rs.DEVICE_MAP["D210_UK"] == "K1_UK"


def test_every_mapped_platform_exists_in_the_dashboard():
    from scripts.rc_comparison import DEVICE_SERIALS
    for device, platform in rs.DEVICE_MAP.items():
        if platform is not None:
            assert platform in DEVICE_SERIALS, f"{device} → {platform} is not a dashboard platform"


def test_platform_for_rejects_unknown_and_octo():
    assert rs.platform_for("D210_UK") == "K1_UK"
    with pytest.raises(rs.SyncError) as e:
        rs.platform_for("D999_US")
    assert e.value.status == 400
    with pytest.raises(rs.SyncError, match="no dashboard platform"):
        rs.platform_for("D810_US")
    assert {"device": "D810_US", "platform": None, "supported": False} in rs.devices()


# ── summary payload ────────────────────────────────────────────────────────

def _report():
    ov = lambda p, k, u: {"total": 100, "pass": p, "fail": 5, "not_executed": 3, "not_applicable": 2,  # noqa: E731
                          "known_failures": k, "unknown_failures": u, "pass_pct": float(p), "known_pct": 1.0}
    return {
        "rc1": "1163", "rc2": "1170", "rc1_ota": "2.6.17.rc.1", "rc2_ota": "2.6.17.rc.2",
        "rc1_overview": ov(90, 3, 2), "overview": ov(88, 4, 3),
        "regressions": {
            "known_count": 1, "unknown_count": 2,
            "known_by_service": {"wifi": [{"tc_id": "TC_9", "name": "n9", "error": "e9", "linked": "DT-1"}]},
            "unknown_by_service": {
                "audio": [{"tc_id": "TC_2", "name": "n2", "error": "x" * 5000, "linked": ""},
                          {"tc_id": "TC_1", "name": "n1", "error": "", "linked": ""}],
            },
        },
        "persistent_failures": {"known_count": 4, "unknown_count": 5},
        "fixed_tcs": {"count": 6}, "stable_tcs": {"count": 70}, "new_tcs": {"count": 7}, "removed_tcs": {"count": 8},
    }


def test_shape_summary_matches_agreed_contract():
    s = rs.shape_summary(_report(), "http://j/1", "http://j/2", "http://perda", now=FIXED_NOW)
    assert set(s) == {"schemaVersion", "generatedAt", "source", "reportLinks", "builds", "overview",
                      "comparison", "regressions"}
    assert s["schemaVersion"] == 1 and s["source"] == "perda-dashboard"
    assert s["generatedAt"] == "2026-11-05T10:00:00Z"
    assert s["reportLinks"] == {"current": "http://j/2", "previous": "http://j/1", "dashboard": "http://perda"}
    assert s["builds"]["previous"] == {"label": "1163", "ota": "2.6.17.rc.1"}
    assert s["builds"]["current"] == {"label": "1170", "ota": "2.6.17.rc.2"}
    assert set(s["overview"]["current"]) == {"total", "pass", "pass_pct", "known_failures", "unknown_failures",
                                             "not_executed", "not_applicable"}
    assert s["overview"]["previous"]["pass"] == 90 and s["overview"]["current"]["pass"] == 88
    assert s["comparison"] == {
        "regressions": {"known": 1, "unknown": 2},
        "persistent_failures": {"known": 4, "unknown": 5},
        "fixed": 6, "stable": 70, "new": 7, "removed": 8,
    }


def test_regressions_are_flat_sorted_and_flagged():
    regs = rs.shape_summary(_report(), now=FIXED_NOW)["regressions"]
    assert [r["tc_id"] for r in regs] == ["TC_1", "TC_2", "TC_9"]       # by service (audio, wifi) then id
    assert [r["service"] for r in regs] == ["audio", "audio", "wifi"]
    by_id = {r["tc_id"]: r for r in regs}
    assert by_id["TC_9"]["known"] is True and by_id["TC_9"]["linked_issue"] == "DT-1"
    assert by_id["TC_1"]["known"] is False and by_id["TC_1"]["linked_issue"] is None
    assert len(by_id["TC_2"]["error"]) == rs.ERROR_TEXT_LIMIT           # long errors are capped
    assert set(by_id["TC_1"]) == {"tc_id", "service", "name", "error", "linked_issue", "known"}


def test_shape_summary_tolerates_an_empty_report():
    s = rs.shape_summary({}, now=FIXED_NOW)
    assert s["regressions"] == [] and s["comparison"]["fixed"] == 0 and s["overview"]["current"]["total"] == 0


# ── refs from the release notes ────────────────────────────────────────────

def test_previous_rc():
    assert rs.previous_rc("x.6.17.rc.2") == "x.6.17.rc.1"
    assert rs.previous_rc("x.6.17.rc.10") == "x.6.17.rc.9"
    assert rs.previous_rc("x.6.17.rc.1") is None
    assert rs.previous_rc("weird") is None


def test_parse_tags_keeps_only_tracked_repos():
    tags = rs.parse_tags("ND_CORE_UTILS_TAG=5.6.17.rc.1\nANALYTICS_TAG=a_b\nSHIELD_TAG=\nDEVICE_BUILD_TAG=dev_6.17")
    assert tags == {"nd_core_utils": "5.6.17.rc.1", "device-build": "dev_6.17"}


def _detail(tags: str):
    return {"overviewDetails": {"productLines": [{"name": "D450_US", "buildBranches": tags}]}}


def test_refs_from_details_blank_where_tag_missing():
    refs = rs.refs_from_details(_detail("SHIELD_TAG=5.6.17.rc.1"), _detail("SHIELD_TAG=5.6.17.rc.2"), "D450_US")
    shield = next(r for r in refs if r["repo"] == "shield")
    assert shield == {"repo": "shield", "base": "5.6.17.rc.1", "head": "5.6.17.rc.2"}
    core = next(r for r in refs if r["repo"] == "nd_core_utils")
    assert core["base"] == "" and core["head"] == ""
    assert len(refs) == len(rs.TAG_REPOS)
    assert rs.refs_from_details(None, None, "D450_US")[0]["base"] == ""


def _http(status=200, body=None):
    r = mock.Mock(status_code=status, ok=status < 400)
    r.json.return_value = body if body is not None else {}
    return r


def test_default_refs_reads_both_rcs_and_404s_on_unknown_rc():
    def get(url, params=None, timeout=None):
        if url.endswith("x.6.17.rc.1"):
            return _http(body=_detail("SHIELD_TAG=old"))
        if url.endswith("x.6.17.rc.2"):
            return _http(body=_detail("SHIELD_TAG=new"))
        return _http(404)

    out = rs.default_refs("x.6.17", "x.6.17.rc.2", "D450_US", get=get)
    assert out["previous_rc"] == "x.6.17.rc.1"
    assert {"repo": "shield", "base": "old", "head": "new"} in out["refs"]
    with pytest.raises(rs.SyncError) as e:
        rs.default_refs("x.6.17", "x.6.17.rc.9", "D450_US", get=get)
    assert e.value.status == 404


# ── GitHub change log ──────────────────────────────────────────────────────

def _commit(sha, msg, parents=1):
    return {"sha": sha * 40, "html_url": f"https://gh/{sha}", "parents": [{}] * parents,
            "commit": {"message": msg, "author": {"name": "Dev"}}}


def test_fetch_compare_extracts_subject_sha_and_jira_keys_and_skips_merges():
    body = {"total_commits": 3, "commits": [
        _commit("a", "Fix wifi drop DT-12\n\nbody mentions DT-99 and TC-5"),
        _commit("b", "Merge branch 'x'", parents=2),
        _commit("c", "plain"),
    ]}
    r = rs.fetch_compare("shield", "v1", "v2", "tok", get=lambda *a, **k: _http(body=body))
    assert [c["subject"] for c in r["commits"]] == ["Fix wifi drop DT-12", "plain"]
    assert r["commits"][0]["sha"] == "aaaaaaa"
    assert r["commits"][0]["jira"] == ["DT-12", "DT-99", "TC-5"]
    assert r["commits"][1]["jira"] == []
    assert r["total"] == 3 and r["error"] == ""
    assert r["compare_url"].endswith("/shield/compare/v1...v2")


def test_fetch_compare_paginates():
    pages = {1: {"total_commits": 150, "commits": [_commit("a", f"c{i}") for i in range(100)]},
             2: {"total_commits": 150, "commits": [_commit("b", f"d{i}") for i in range(50)]}}
    calls = []

    def get(url, headers=None, params=None, timeout=None):
        calls.append(params["page"])
        return _http(body=pages[params["page"]])

    r = rs.fetch_compare("shield", "v1", "v2", "tok", get=get)
    assert calls == [1, 2] and len(r["commits"]) == 150


def test_fetch_compare_errors():
    assert "both a base and a head" in rs.fetch_compare("r", "", "v2", "t")["error"]
    assert "Ref not found" in rs.fetch_compare("r", "a", "b", "t", get=lambda *a, **k: _http(404))["error"]
    assert "HTTP 500" in rs.fetch_compare("r", "a", "b", "t", get=lambda *a, **k: _http(500))["error"]
    with pytest.raises(rs.SyncError, match="rejected GITHUB_TOKEN"):
        rs.fetch_compare("r", "a", "b", "t", get=lambda *a, **k: _http(401))


def _result(repo, n, subject="s"):
    return {"repo": repo, "base": "v1", "head": "v2", "compare_url": f"https://gh/{repo}", "error": "",
            "total": n, "commits": [{"sha": "abc1234", "subject": f"{subject}{i}", "jira": ["DT-1"] if i % 2 else []}
                                    for i in range(n)]}


def test_format_changelog_layout():
    text = rs.format_changelog([_result("shield", 2), _result("nd_vdm", 0),
                                {**_result("bad", 1), "error": "boom"}])
    assert text.splitlines()[0] == "## shield (v1 → v2) — 2 commits"
    assert "- s0 (abc1234)" in text and "- s1 (abc1234) [DT-1]" in text
    assert "nd_vdm" not in text and "bad" not in text       # empty and failed repos are left out


def test_format_changelog_never_exceeds_limit_and_says_what_was_cut():
    text = rs.format_changelog([_result("shield", 3000, "x" * 40), _result("nd_vdm", 5)], limit=2000)
    assert len(text) <= 2000
    assert "more, see https://gh/shield" in text
    big = rs.format_changelog([_result(f"r{i}", 40) for i in range(30)], limit=1500)
    assert len(big) <= 1500 and "repo(s) omitted" in big
    assert len(rs.format_changelog([_result("shield", 5000, "y" * 30)])) <= rs.CHANGELOG_LIMIT


# ── dry run ────────────────────────────────────────────────────────────────

def test_dry_run_builds_the_patch_without_sending():
    d = rs.build_dry_run("x.6.17", "x.6.17.rc.2", "DT", {"D450_US": {"a": 1}}, "log")
    assert d["sent"] is False and d["method"] == "PATCH"
    assert d["url"].endswith("/api/releases/x.6.17/x.6.17.rc.2/open-sections?project=DT")
    assert d["body"] == {"testAutomationSummary": {"D450_US": {"a": 1}}, "testAutomationChangeLog": "log"}


def test_dry_run_omits_empty_parts_and_validates():
    d = rs.build_dry_run("x.6.17", "x.6.17.rc.2", "DT", {}, "only log")
    assert list(d["body"]) == ["testAutomationChangeLog"]
    with pytest.raises(rs.SyncError, match="Nothing to send"):
        rs.build_dry_run("x.6.17", "x.6.17.rc.2", "DT", {}, "  ")
    with pytest.raises(rs.SyncError, match="20000"):
        rs.build_dry_run("x.6.17", "x.6.17.rc.2", "DT", {}, "x" * 20001)
