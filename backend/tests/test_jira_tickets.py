"""Unit tests for the Release Tickets Jira client (no network: requests is stubbed)."""
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("JIRA_EMAIL", "a@b.c")
os.environ.setdefault("JIRA_API_TOKEN", "t")

import jira_tickets as j  # noqa: E402


def test_build_jql_quotes_and_sprint_kinds():
    assert j.build_jql('x.6.19.rc.1', "", "") == 'fixVersion = "x.6.19.rc.1" ORDER BY key DESC'
    assert 'sprint = 42' in j.build_jql("v", "P", "42")
    assert 'sprint = "S \\"1\\""' in j.build_jql("v", "P", 'S "1"')
    assert 'project = "Device_Tracker"' in j.build_jql("v", "Device_Tracker", "")


def test_tc_links_keeps_only_tc_project_sorted_unique():
    links = [
        {"outwardIssue": {"key": "TC-10"}},
        {"inwardIssue": {"key": "DT-1"}},
        {"outwardIssue": {"key": "TC-9"}},
        {"outwardIssue": {"key": "TC-10"}},
        {},
    ]
    assert j._tc_links(links) == ["TC-9", "TC-10"]
    assert j._tc_links(None) == []


def test_shape_handles_missing_fields():
    t = j._shape({"key": "DT-1", "id": "7", "fields": {"summary": "s", "assignee": None, "resolution": None}})
    assert t["assignee"] == "" and t["resolution"] == "" and t["tc_tickets"] == [] and t["id"] == "7"


def _resp(ok=True, body=None):
    r = mock.Mock(ok=ok, status_code=200 if ok else 500)
    r.json.return_value = body or {}
    return r


def test_fetch_prs_parses_status_repo_and_caches():
    j._pr_cache.clear()
    body = {"detail": [{"pullRequests": [{
        "id": "#5", "name": "T", "url": "u", "status": "merged",
        "repositoryName": "org/repo", "author": {"name": "A"}, "destination": {"branch": "dev"},
    }]}]}
    with mock.patch.object(j.requests, "get", return_value=_resp(body=body)) as g:
        first = j._fetch_prs("99")
        second = j._fetch_prs("99")
    assert first == second == [{"id": "#5", "title": "T", "url": "u", "status": "MERGED",
                                "repo": "repo", "author": "A", "target": "dev"}]
    assert g.call_count == 1  # second call came from the cache


def test_fetch_prs_failure_is_unknown_not_empty():
    j._pr_cache.clear()
    with mock.patch.object(j.requests, "get", return_value=_resp(ok=False)):
        assert j._fetch_prs("1") is None
    j._pr_cache.clear()
    with mock.patch.object(j.requests, "get", side_effect=j.requests.ConnectionError()):
        assert j._fetch_prs("2") is None


def test_fetch_prs_by_key_ignores_bad_keys_and_resolves_ids():
    j._pr_cache.clear(); j._issue_ids.clear()
    with mock.patch.object(j.requests, "post", return_value=_resp(body={"issues": [{"key": "DT-1", "id": "11"}]})), \
         mock.patch.object(j.requests, "get", return_value=_resp(body={"detail": []})):
        out = j.fetch_prs(["DT-1", "bad key; DROP", "DT-1"])
    assert out == {"DT-1": []}
