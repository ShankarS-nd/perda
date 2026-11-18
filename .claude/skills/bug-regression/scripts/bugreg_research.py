#!/usr/bin/env python3
"""
bugreg_research.py -- deterministic evidence-gathering for one Jira ticket.

Prototype of bug_regression/{jira,github,framework}/*.py collapsed into one script
for the pilot stage. Everything here is deterministic (Jira REST, git, AST, xlsx
parsing, TF-IDF) -- no model calls. Output is a single research_bundle.json that
an AI step (currently: this conversation) reads to produce:
  - bug_analysis.json      (structured bug intelligence)
  - the candidate .py test (dict_list, using this bundle's manifest + oracle candidates)
which are then run through validate_candidate.py.

Usage:
  python3 out/bugreg_research.py DT-1234 --branch BI_6.16_20251108
  python3 out/bugreg_research.py DT-1234 --branch BI_6.16_20251108 --refresh

Writes:
  out/<TICKET>/research_bundle.json   (full evidence, machine-readable)
  out/<TICKET>/research_bundle.md     (human-readable digest)
  out/_cache/jira/<TICKET>.json       (raw Jira response, reused on rerun)
  out/_cache/manifest/<branch>.json   (DSL capability manifest, reused across tickets)
  out/_cache/registry/<branch>.json   (main_db.xlsx parse, reused across tickets)
"""
import argparse
import ast
import base64
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from collections import Counter
from pathlib import Path

warnings.filterwarnings("ignore", category=SyntaxWarning)  # target repo sources contain
                                                             # regex escapes ast.parse warns about

ROOT = Path(os.environ.get("BUGREG_PROJECT_ROOT", ".")).resolve()
ENV_PATH = ROOT / ".env"
CACHE_DIR = ROOT / "out" / "_cache"
DEVICE_REPOS = ["nd_device_services", "nd_core_utils", "nd_test_bot"]

STOP = set("""the a an is are was were be been in on of to for and or not with when
after before that this it if as by from will does do device verify check test case
should when both are only can when""".split())


# ---------------------------------------------------------------------------
# env / http
# ---------------------------------------------------------------------------

def load_env():
    env = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def jira_get(env, path, retries=3, backoff=2.0):
    base = env["JIRA_BASE_URL"].rstrip("/")
    auth = base64.b64encode(f"{env['JIRA_EMAIL']}:{env['JIRA_API_TOKEN']}".encode()).decode()
    req = urllib.request.Request(
        base + path,
        headers={"Authorization": "Basic " + auth, "Accept": "application/json"},
    )
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, {"_error": e.read()[:500].decode("utf8", "ignore")}
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_err = e
            if attempt < retries:
                print(f"      network error ({e.reason if hasattr(e, 'reason') else e}), "
                      f"retry {attempt}/{retries - 1} in {backoff:.0f}s ...", file=sys.stderr)
                time.sleep(backoff)
                backoff *= 2
    raise SystemExit(
        f"\nCould not reach {base} after {retries} attempts: {last_err}\n"
        f"This is a network/DNS problem on this machine, not a script or Jira issue -- "
        f"check connectivity (VPN, wifi, DNS) and rerun the same command; the Jira cache "
        f"means nothing already fetched will be re-fetched unnecessarily."
    )


def adf_to_text(node, out=None):
    if out is None:
        out = []
    if isinstance(node, dict):
        t = node.get("type")
        if t == "text":
            out.append(node.get("text", ""))
        elif t == "hardBreak":
            out.append("\n")
        elif t == "mention":
            out.append("@" + node.get("attrs", {}).get("text", ""))
        elif t in ("paragraph", "heading", "listItem", "tableCell", "tableRow", "codeBlock", "blockquote"):
            for c in node.get("content", []) or []:
                adf_to_text(c, out)
            out.append("\n")
        else:
            for c in node.get("content", []) or []:
                adf_to_text(c, out)
    elif isinstance(node, list):
        for c in node:
            adf_to_text(c, out)
    return out


def txt(v):
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    return "".join(adf_to_text(v)).strip()


TEXT_ATTACHMENT_EXTS = (".md", ".txt", ".log", ".ini", ".json", ".yaml", ".yml", ".py", ".sh", ".cfg", ".conf")


def fetch_attachment_text(env, url, max_bytes=20000):
    """Fetches a Jira attachment's raw content as text (best-effort). Used for
    human-readable attachments (README.md, .txt notes, etc.) linked from a ticket --
    a real evidence source that's easy to miss since it never appears in any field,
    structured or free-text. Returns '' on any failure (binary content, network error,
    oversized file) rather than raising, since this is a best-effort supplement."""
    base = env["JIRA_BASE_URL"].rstrip("/")
    auth = base64.b64encode(f"{env['JIRA_EMAIL']}:{env['JIRA_API_TOKEN']}".encode()).decode()
    req = urllib.request.Request(url, headers={"Authorization": "Basic " + auth})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read(max_bytes + 1)
            truncated = len(raw) > max_bytes
            return raw[:max_bytes].decode("utf-8", "replace") + ("\n...[truncated]" if truncated else "")
    except Exception as e:
        return f"(could not fetch attachment: {e})"


# ---------------------------------------------------------------------------
# stage 1-2: fetch + normalize
# ---------------------------------------------------------------------------

def fetch_jira(env, ticket, refresh):
    cache = CACHE_DIR / "jira" / f"{ticket}.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists() and not refresh:
        return json.loads(cache.read_text()), True

    status, data = jira_get(env, f"/rest/api/3/issue/{ticket}?expand=names,renderedFields")
    if status != 200:
        raise SystemExit(f"Jira fetch failed for {ticket}: HTTP {status} {data}")
    cache.write_text(json.dumps(data))
    return data, False


def normalize_bug(raw):
    f = raw["fields"]
    names = raw.get("names", {})

    custom = {}
    for fid, val in f.items():
        if fid.startswith("customfield_") and val:
            t = txt(val) if isinstance(val, (dict, str)) else ""
            if t and len(t) > 3 and not t.startswith("{"):
                custom[names.get(fid, fid)] = t

    links = []
    for l in f.get("issuelinks", []):
        other = l.get("outwardIssue") or l.get("inwardIssue")
        if not other:
            continue
        links.append({
            "type": l.get("type", {}).get("name"),
            "key": other["key"],
            "issuetype": other.get("fields", {}).get("issuetype", {}).get("name"),
            "summary": other.get("fields", {}).get("summary"),
            "status": other.get("fields", {}).get("status", {}).get("name"),
        })

    comments = []
    for c in f.get("comment", {}).get("comments", []):
        comments.append({"author": c["author"]["displayName"], "created": c["created"][:10],
                          "body": txt(c["body"])[:2000]})

    return {
        "key": raw["key"],
        "url": None,  # filled by caller with base_url
        "issuetype": f["issuetype"]["name"],
        "status": f["status"]["name"],
        "priority": (f.get("priority") or {}).get("name"),
        "summary": f["summary"],
        "description": txt(f.get("description")),
        "labels": f.get("labels", []),
        "components": [c["name"] for c in f.get("components") or []],
        "affected_versions": [v["name"] for v in f.get("versions") or []],
        "fix_versions": [v["name"] for v in f.get("fixVersions") or []],
        "root_cause": custom.get("Root Cause Description", ""),
        "resolution": custom.get("Resolution Description", ""),
        "implementation_plan": custom.get("Implementation plan", ""),
        "other_custom_fields": {k: v for k, v in custom.items()
                                 if k not in ("Root Cause Description", "Resolution Description",
                                              "Implementation plan", "Rank", "[CHART] Time in Status",
                                              "[CHART] Date of First Response")},
        "linked_issues": links,
        "linked_tests": [l for l in links if l["type"] == "Test"],
        "comments": comments,
    }


# ---------------------------------------------------------------------------
# stage 2a: authoritative linked PRs via Jira's Development panel (dev-status API)
#
# This is NOT the regular issue JSON -- Jira exposes linked PR/branch/commit data through
# a separate, undocumented-but-stable endpoint. Confirmed against real tickets (DT-3948,
# DT-4290, DT-3961) that this Netradyne Jira instance has the GitHub Development panel
# wired up (integration id "oAuth-com.github.integration.production" -- the generic
# "GitHub" applicationType returns an empty list, so the exact instance key matters).
#
# Why this matters over the grep-based locate_fix() below: grep only finds a commit if its
# message happens to mention the ticket key. dev-status is authoritative -- it is exactly
# what a human sees by clicking "Development > N pull requests" on the ticket, so it never
# misses a linked PR and never picks up an unrelated commit that coincidentally mentions the
# ticket key. It also gives the real source/destination branch names directly, which lets us
# compute a genuine before/after `git diff` instead of only reading the post-fix file content.
# ---------------------------------------------------------------------------

DEV_STATUS_APP_TYPE = "oAuth-com.github.integration.production"


def fetch_dev_status(env, ticket):
    """Returns the list of PRs Jira's Development panel has linked to `ticket`, or []
    if the issue has none / the integration isn't configured for this project."""
    status, issue = jira_get(env, f"/rest/api/3/issue/{ticket}?fields=id")
    if status != 200:
        return []
    issue_id = issue.get("id")
    if not issue_id:
        return []

    status, detail = jira_get(
        env, f"/rest/dev-status/1.0/issue/detail?issueId={issue_id}"
        f"&applicationType={DEV_STATUS_APP_TYPE}&dataType=pullrequest")
    if status != 200:
        return []

    prs = []
    for d in detail.get("detail", []):
        for pr in d.get("pullRequests", []):
            prs.append({
                "id": pr.get("id"),
                "name": pr.get("name"),
                "status": pr.get("status"),
                "repository": pr.get("repositoryName"),
                "source_branch": pr.get("source", {}).get("branch"),
                "destination_branch": pr.get("destination", {}).get("branch"),
                "url": pr.get("url"),
            })
    return prs


def pr_diff(pr, repos_dir):
    """Real before/after diff for one merged PR, computed locally against the already-
    cloned repo -- no GitHub API call, no token needed. Returns a dict with either a
    'diff' (unified diff text, capped) or an 'unavailable' reason, never both."""
    repo_name = pr["repository"].split("/")[-1] if pr.get("repository") else None
    repo_path = repos_dir / repo_name if repo_name else None

    if pr["status"] != "MERGED":
        return {**pr, "unavailable": f"status is {pr['status']}, not MERGED -- skipping diff"}
    if not repo_path or not repo_path.is_dir():
        return {**pr, "unavailable": f"repo {repo_name!r} is not cloned in {repos_dir} -- "
                                      f"cannot compute a diff locally"}

    src, dst = pr["source_branch"], pr["destination_branch"]
    diff = run(["git", "diff", f"origin/{dst}...origin/{src}"], repo_path)
    if not diff.strip():
        # branch refs may be gone post-merge on a squash workflow; fall back to searching
        # the destination branch's own history for a commit whose message names the PR id
        pr_num = re.search(r"#(\d+)", pr.get("id", "") or "") or re.search(r"\(#(\d+)\)", pr.get("name", "") or "")
        log = run(["git", "log", "--all", "--oneline", "-i",
                   f"--grep={pr['id'].lstrip('#')}" if pr.get("id") else "--grep=NEVERMATCH"], repo_path)
        sha = log.splitlines()[0].split(" ", 1)[0] if log.strip() else None
        if sha:
            diff = run(["git", "show", sha], repo_path)
    if not diff.strip():
        return {**pr, "unavailable": f"branches {src!r}/{dst!r} not resolvable and no "
                                      f"matching commit found in local history"}
    return {**pr, "diff": diff[:20000], "diff_truncated": len(diff) > 20000}


# ---------------------------------------------------------------------------
# stage 3-4: locate the fix in git, extract oracle candidates
# ---------------------------------------------------------------------------

def fetch_linked_test_cases(env, linked_tests, refresh):
    """Fetches the full content of every linked Jira "Test"-type issue (a TC-project
    ticket) -- not just the shallow key/summary/status normalize_bug() already captures.

    These are human-authored manual test cases, often written by whoever verified the
    fix -- when present, they're frequently a STRONGER source than the PR diff alone for
    designing an automated regression test: real forcing commands, real device log
    output, and confirmation of which outcomes are actually valid (a PR diff shows the
    fixed code, not what a human tester actually observed running it). Always read
    these before designing a candidate if any exist -- they can outrank the diff.

    Field IDs for test steps/preconditions/expected-result vary by Jira test-management
    app config, so this looks fields up BY NAME (via the issue's own `names` map, same
    technique normalize_bug() already uses for Root Cause/Resolution) rather than
    hardcoding customfield_XXXXX IDs, which is not portable across differently-configured
    Jira instances/projects.
    """
    results = []
    for lt in linked_tests:
        key = lt["key"]
        cache = CACHE_DIR / "jira" / f"{key}.json"
        cache.parent.mkdir(parents=True, exist_ok=True)
        if cache.exists() and not refresh:
            data = json.loads(cache.read_text())
        else:
            status, data = jira_get(env, f"/rest/api/3/issue/{key}?expand=names,renderedFields")
            if status != 200:
                results.append({"key": key, "error": f"HTTP {status}", **lt})
                continue
            cache.write_text(json.dumps(data))

        f = data["fields"]
        names = data.get("names", {})

        def field_by_name_substr(*substrs):
            for fid, val in f.items():
                if not fid.startswith("customfield_") or not val:
                    continue
                label = names.get(fid, "")
                if any(s.lower() in label.lower() for s in substrs):
                    t = txt(val) if isinstance(val, (dict, str)) else ""
                    if t:
                        return t
            return ""

        def single_choice_field(*substrs):
            for fid, val in f.items():
                if not fid.startswith("customfield_") or not val:
                    continue
                label = names.get(fid, "")
                if any(s.lower() in label.lower() for s in substrs):
                    if isinstance(val, list) and val and isinstance(val[0], dict):
                        return val[0].get("value")
                    if isinstance(val, dict):
                        return val.get("value")
            return None

        # A human tester sometimes puts the real content in the ticket's own free-text
        # description (e.g. "see description") instead of, or in addition to, the
        # structured Preconditions/Steps/Expected Result fields -- always fetch it too,
        # never assume the structured fields are the whole story.
        description = txt(f.get("description"))

        # Likewise, an attached README or notes file is real evidence that never shows
        # up in any field. List every attachment; fetch the content of text-like ones
        # (a build/usage README for a real on-device test tool has outranked the PR diff
        # before -- see DT-3359/TC-3916).
        attachments = []
        for att in f.get("attachment", []) or []:
            filename = att.get("filename", "")
            entry = {"filename": filename, "size": att.get("size"), "url": att.get("content")}
            if filename.lower().endswith(TEXT_ATTACHMENT_EXTS) and att.get("content"):
                entry["text"] = fetch_attachment_text(env, att["content"])
            attachments.append(entry)

        results.append({
            "key": key,
            "summary": f.get("summary"),
            "status": (f.get("status") or {}).get("name"),
            "product_supported": single_choice_field("ProductSupported", "Product"),
            "service_component": single_choice_field("Service", "Component Name"),
            "preconditions": field_by_name_substr("Precondition"),
            "steps": field_by_name_substr("TestStep", "Test Step", "Execution Step"),
            "expected_result": field_by_name_substr("ExpectedResult", "Expected Result"),
            "description": description,
            "attachments": attachments,
        })
    return results


def run(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, errors="replace")
    return r.stdout


def locate_fix(ticket, repos_dir):
    findings = {"repos": {}}
    for repo in DEVICE_REPOS:
        repo_path = repos_dir / repo
        if not repo_path.is_dir():
            continue
        entry = {"matching_branches": [], "matching_commits": []}

        branches = run(["git", "branch", "-r"], repo_path)
        for line in branches.splitlines():
            b = line.strip()
            if re.search(rf"\b{re.escape(ticket)}\b", b, re.I):
                entry["matching_branches"].append(b)

        log = run(["git", "log", "--all", "--oneline", "--no-merges", "-i",
                   f"--grep={ticket}"], repo_path)
        for line in log.splitlines():
            if not line.strip():
                continue
            sha, _, subject = line.partition(" ")
            files = run(["git", "show", "--stat", "--format=", sha], repo_path)
            changed = re.findall(r"^\s*(\S+\.(?:cpp|h|hpp|c|py|sh|ini))\s*\|", files, re.M)
            entry["matching_commits"].append({"sha": sha, "subject": subject,
                                               "changed_files": changed})
        if entry["matching_branches"] or entry["matching_commits"]:
            findings["repos"][repo] = entry
    return findings


LOG_CALL_RE = re.compile(r'\b(?:LOG_[IEWDF]|LOG)\s*\(\s*TAG\s*,\s*"((?:[^"\\]|\\.)*)"', re.S)


FUNC_DEF_RE = re.compile(r'^[\w:&*<> ]*?\b(\w+)\s*\([^;{}]*\)\s*\n?\s*\{', re.M)
CONTROL_KEYWORDS = {"if", "for", "while", "switch", "else", "catch", "do"}


def enclosing_function(content, pos):
    """Best-effort: name of the nearest real function definition preceding a byte offset.
    Used only to add human-readable context to a candidate -- never to filter it."""
    best = None
    for m in FUNC_DEF_RE.finditer(content):
        if m.start() > pos:
            break
        if m.group(1) not in CONTROL_KEYWORDS:
            best = m.group(1)
    return best


def extract_oracle_candidates(ticket, locate_result, bug, repos_dir, max_commits=3, keep=40):
    """For each located commit, pull the post-fix file content and harvest LOG_* format
    strings, ranked by lexical overlap against the bug's summary + root cause + resolution
    (+ description, see below) text combined. Deterministic -- these are candidate oracles for
    a human/AI to pick from, not an assertion that they are correct.

    Root cause / resolution text matters far more here than the summary: a bug summary
    describes the user-visible symptom ("IP not acquired"), while the fix's log lines encode
    the developer's decision variables ("ext_cam=0, iosix=0, wifi_fallback=1"). Those variable
    names typically appear in the Resolution / Root Cause fields (developer-authored) but not
    in the summary (reporter-authored). Ranking against summary alone buries the most useful
    oracle under generic log lines that happen to share summary vocabulary.

    'Root Cause Description' / 'Resolution Description' are field NAMES specific to how the DT
    project happens to be configured -- other Jira projects (confirmed: OCTO) don't have them at
    all, so normalize_bug() correctly returns "" for both there, not an error. description is
    always included too for exactly this reason: on a project without those structured fields,
    it is often the only place real technical detail (exact error strings, config values, sensor
    ranges) actually lives.

    Scoring is IDF-weighted (document frequency computed over this ticket's OWN candidate log
    lines), not a flat token-overlap count -- confirmed necessary, not just theoretical: a real
    OCTO ticket's description (no root_cause/resolution fields to keep the query short) added ~140
    tokens once root_cause/resolution were unavailable, and a flat count let generic words shared
    across many unrelated LOG_* lines ("read", "failed", "set", "default" -- common in firmware
    log messages, not caught by the STOP list which targets grammatical words) outscore the one
    line that actually mattered ("Invalid voltage read: %f", sharing the rarer "voltage"/"invalid").
    IDF weighting fixes this without needing to shorten the query text -- a shared rare word
    ("voltage") counts for more than a shared common one ("read"), the same principle already used
    for coverage_mapping()'s own scoring elsewhere in this file.
    """
    query_tokens = set(w for w in re.findall(
        r"[a-z0-9_]+",
        " ".join([bug["summary"], bug["root_cause"], bug["resolution"],
                   strip_pasted_log_lines(bug["description"])]).lower(),
    ) if w not in STOP and len(w) > 2)

    raw_candidates = []
    for repo, info in locate_result["repos"].items():
        repo_path = repos_dir / repo
        for commit in info["matching_commits"][:max_commits]:
            for fpath in commit["changed_files"]:
                if not fpath.endswith((".cpp", ".h", ".hpp", ".c")):
                    continue
                content = run(["git", "show", f"{commit['sha']}:{fpath}"], repo_path)
                if not content:
                    continue
                for m in LOG_CALL_RE.finditer(content):
                    line = m.group(1)
                    toks = set(w for w in re.findall(r"[a-z0-9_]+", line.lower())
                               if w not in STOP and len(w) > 2)
                    overlap_toks = toks & query_tokens
                    if not overlap_toks and "%" not in line:
                        continue
                    raw_candidates.append({
                        "repo": repo, "commit": commit["sha"], "file": fpath,
                        "log_format": line,
                        "enclosing_function": enclosing_function(content, m.start()),
                        "_overlap_toks": overlap_toks,
                    })

    n_docs = len(raw_candidates) or 1
    df = Counter()
    for c in raw_candidates:
        df.update(c["_overlap_toks"])

    def idf(w):
        return math.log((n_docs + 1) / (df.get(w, 0) + 1)) + 1

    candidates = []
    for c in raw_candidates:
        score = sum(idf(w) for w in c["_overlap_toks"])
        c["relevance_token_overlap"] = round(score, 3)
        del c["_overlap_toks"]
        candidates.append(c)
    candidates.sort(key=lambda c: -c["relevance_token_overlap"])
    seen, deduped = set(), []
    for c in candidates:
        if c["log_format"] in seen:
            continue
        seen.add(c["log_format"])
        deduped.append(c)
    return deduped[:keep]


# ---------------------------------------------------------------------------
# stage 6: DSL capability manifest (AST over the pinned nd_test_bot branch)
# ---------------------------------------------------------------------------

def git_show(repo_path, branch, path):
    r = subprocess.run(["git", "show", f"{branch}:{path}"], cwd=repo_path,
                        capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def build_manifest(repo_path, branch):
    cache = CACHE_DIR / "manifest" / f"{branch.replace('/', '_')}.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        return json.loads(cache.read_text())

    da = git_show(repo_path, branch, "Test_Automation_Framework/Lib/apis/dictionary_api.py")
    if da is None:
        raise SystemExit(f"Could not read dictionary_api.py on {branch} -- check the branch name")
    block_m = re.search(r"self\.objects\s*=\s*\{(.*?)\n\s*\}", da, re.S)
    registry = {}
    for m in re.finditer(r"'(\w+_obj)'\s*:\s*(\w+)\s*\(", block_m.group(1)):
        registry[m.group(1)] = m.group(2)

    files_out = run(["git", "ls-tree", "-r", "--name-only", branch], repo_path)
    libs = [f for f in files_out.splitlines()
            if re.match(r"Test_Automation_Framework/Lib/.*\.py$", f)]

    cls2meth = {}
    for f in libs:
        src = git_show(repo_path, branch, f)
        if not src:
            continue
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            meths = {}
            for b in node.body:
                if isinstance(b, (ast.FunctionDef, ast.AsyncFunctionDef)) and not b.name.startswith("_"):
                    a = b.args
                    pos = [x.arg for x in a.args if x.arg != "self"]
                    defs = [ast.unparse(d) for d in a.defaults]
                    npos = len(pos) - len(defs)
                    sig = [p if i < npos else f"{p}={defs[i - npos]}" for i, p in enumerate(pos)]
                    if a.vararg:
                        sig.append("*" + a.vararg.arg)
                    doc = (ast.get_docstring(b) or "").strip().split("\n")[0][:90]
                    meths[b.name] = {"sig": sig, "doc": doc,
                                      "file": f.replace("Test_Automation_Framework/", "")}
            if meths:
                cls2meth.setdefault(node.name, {}).update(meths)

    manifest = {}
    for obj, cls in registry.items():
        if cls in cls2meth:
            manifest[obj] = {"class": cls, "methods": cls2meth[cls]}
    cache.write_text(json.dumps(manifest, indent=1))
    return manifest


# ---------------------------------------------------------------------------
# stage 7: registry (main_db.xlsx) -- handles BOTH shared-string and inline-string xlsx
# ---------------------------------------------------------------------------

def parse_xlsx_cells(row_xml, shared):
    d = {}
    for m in re.finditer(r'<c\b([^>]*)>(.*?)</c>', row_xml, re.S):
        attrs, body = m.group(1), m.group(2)
        ref = re.search(r'r="([A-Z]+)\d+"', attrs)
        if not ref:
            continue
        ctype = re.search(r't="(\w+)"', attrs)
        ctype = ctype.group(1) if ctype else "n"
        val = ""
        if ctype == "s":
            v = re.search(r"<v>(\d+)</v>", body)
            if v and int(v.group(1)) < len(shared):
                val = shared[int(v.group(1))]
        elif ctype == "inlineStr":
            t = re.findall(r"<t[^>]*>(.*?)</t>", body, re.S)
            val = t[0] if t else ""
        else:
            t = re.findall(r"<t[^>]*>(.*?)</t>", body, re.S)
            v = re.findall(r"<v>(.*?)</v>", body, re.S)
            val = t[0] if t else (v[0] if v else "")
        d[ref.group(1)] = re.sub("<.*?>", "", val).strip()
    return d


def build_registry(repo_path, branch):
    cache = CACHE_DIR / "registry" / f"{branch.replace('/', '_')}.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        return json.loads(cache.read_text())

    raw = subprocess.run(["git", "show", f"{branch}:Test_Automation_Framework/main_db.xlsx"],
                          cwd=repo_path, capture_output=True).stdout
    tmp = CACHE_DIR / "registry" / f"{branch.replace('/', '_')}.xlsx"
    tmp.write_bytes(raw)

    import zipfile
    z = zipfile.ZipFile(tmp)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        s = z.read("xl/sharedStrings.xml").decode("utf8", "ignore")
        shared = [re.sub("<.*?>", "", x) for x in re.findall(r"<si>(.*?)</si>", s, re.S)]
    sheet = z.read("xl/worksheets/sheet1.xml").decode("utf8", "ignore")
    rows = re.findall(r"<row[^>]*>(.*?)</row>", sheet, re.S)

    hdr = parse_xlsx_cells(rows[0], shared)
    idx = {v: k for k, v in hdr.items()}
    stable_cols = sorted((k for k in idx if k.endswith("_Stable") and k != "QA_Stable"),
                         key=lambda k: [int(p) for p in re.findall(r"\d+", k)] or [0])
    latest_stable_col = idx.get(stable_cols[-1]) if stable_cols else None

    recs = []
    for r in rows[1:]:
        c = parse_xlsx_cells(r, shared)
        fn = c.get(idx.get("file_name", ""), "")
        if not fn:
            continue
        # component derived the same way execution.py does it -- Service_name is too sparse to trust
        try:
            svc = re.split(r"_|-", fn, maxsplit=1)[1].split("_")[1]
        except Exception:
            svc = ""
        recs.append({
            "file": fn,
            "description": c.get(idx.get("description", ""), ""),
            "component": svc,
            "service_name_field": c.get(idx.get("Service_name", ""), ""),
            "stable_current": c.get(latest_stable_col, "") if latest_stable_col else "",
            "stable_current_column": stable_cols[-1] if stable_cols else None,
            "qa_stable": c.get(idx.get("QA_Stable", ""), ""),
        })
    tmp.unlink()
    cache.write_text(json.dumps(recs))
    return recs


# ---------------------------------------------------------------------------
# stage 8a: component inference (labels first -- deterministic and high-confidence
#            when they hit; summary/description token overlap as a fallback)
# ---------------------------------------------------------------------------

DEVICE_LOG_LINE_RE = re.compile(r"^\s*\d{10,14}:\s*\d+:\s*\S*:\s*[A-Za-z]:\s*\d+:\s*\d+:", re.M)


def strip_pasted_log_lines(text):
    """Bug descriptions routinely paste raw device log excerpts as evidence. Those lines
    mention services/threads incidentally (a permission check, an adjacent thread name, a
    status line) that have nothing to do with the bug's actual component -- e.g. a log line
    about 'DMS camera not connected, speed registration thread exiting' inside a report that
    is actually about privacy-mode timing. Component inference must not treat that as signal.
    Detected by the device logger's own fixed shape: <epoch_ms>: <offset_ms>: <TAG>: <level>:
    <pid>: <tid>: <message>."""
    return "\n".join(line for line in text.splitlines() if not DEVICE_LOG_LINE_RE.match(line))


def infer_components(bug, registry):
    folders = sorted({r["component"] for r in registry if r["component"]})

    label_hits = []
    for label in bug["labels"]:
        ll = label.lower().replace("-", "_")
        for f in folders:
            fl = f.lower().replace("-", "_")
            if ll == fl or ll in fl or fl in ll:
                label_hits.append({"folder": f, "matched_label": label, "confidence": "high"})

    if label_hits:
        return {"method": "label_match", "candidates": label_hits}

    clean_description = strip_pasted_log_lines(bug["description"])
    text = (bug["summary"] + " " + clean_description).lower()
    tokens = set(re.findall(r"[a-z0-9_]+", text))
    weak = []
    for f in folders:
        fl = f.lower().replace("-", "_").replace("manager", "").strip("_")
        if len(fl) >= 3 and fl in tokens:
            weak.append({"folder": f, "matched_token": fl, "confidence": "low"})
    return {"method": "summary_token_overlap" if weak else "none",
            "candidates": weak,
            "warning": "No label matched a test folder name. Component is a weak guess -- "
                       "confirm manually before trusting the coverage-mapping stage."}


# ---------------------------------------------------------------------------
# stage 8b: coverage mapping -- TF-IDF cosine, gated to inferred component(s)
# ---------------------------------------------------------------------------

def toks(s):
    return [w for w in re.findall(r"[a-z0-9_]+", s.lower()) if w not in STOP and len(w) > 2]


def coverage_mapping(bug, registry, components):
    docs = [toks(r["description"] + " " + r["file"]) for r in registry]
    df = Counter()
    for d in docs:
        df.update(set(d))
    n = len(docs)

    def idf(w):
        return math.log((n + 1) / (df.get(w, 0) + 1)) + 1

    query_text = " ".join([bug["summary"], bug["description"], bug["root_cause"], bug["resolution"]])
    qv = Counter(toks(query_text))

    def score(d):
        dv = Counter(d)
        num = sum((1 + math.log(c)) * (1 + math.log(dv[w])) * idf(w) ** 2
                   for w, c in qv.items() if w in dv)
        qn = math.sqrt(sum(((1 + math.log(c)) * idf(w)) ** 2 for w, c in qv.items()))
        dn = math.sqrt(sum(((1 + math.log(c)) * idf(w)) ** 2 for w, c in dv.items()))
        return num / (qn * dn) if qn and dn else 0.0

    scored = [(score(d), r) for d, r in zip(docs, registry)]
    scored.sort(key=lambda x: -x[0])

    gated = [(s, r) for s, r in scored if r["component"] in components] if components else scored
    return {
        "gated_to_components": components,
        "note": "Empty components list means no reliable component was inferred -- "
                "these are UNGATED global matches and are much less trustworthy." if not components else None,
        "top_matches": [{"score": round(s, 4), "file": r["file"], "description": r["description"],
                          "qa_stable": r["qa_stable"]} for s, r in gated[:10]],
    }


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("ticket", help="Jira key, e.g. DT-1234")
    ap.add_argument("--branch", required=True, help="nd_test_bot branch/ref to pin, e.g. BI_6.16_20251108")
    ap.add_argument("--repos-dir", default=str(ROOT / "repos"))
    ap.add_argument("--refresh", action="store_true", help="ignore the Jira cache and re-fetch")
    args = ap.parse_args()

    ticket = args.ticket.upper()
    branch = args.branch if args.branch.startswith("origin/") else f"origin/{args.branch}"
    repos_dir = Path(args.repos_dir)
    test_bot = repos_dir / "nd_test_bot"

    print(f"[1/6] Fetching {ticket} from Jira ...")
    env = load_env()
    raw, from_cache = fetch_jira(env, ticket, args.refresh)
    print(f"      {'cache hit' if from_cache else 'fetched live'}")

    bug = normalize_bug(raw)
    bug["url"] = env["JIRA_BASE_URL"].rstrip("/") + f"/browse/{ticket}"
    if not bug["root_cause"] and not bug["resolution"]:
        print(f"      NOTE: this project's tickets don't populate 'Root Cause Description' / "
              f"'Resolution Description' (confirmed: not every Jira project uses those field "
              f"names -- e.g. OCTO doesn't). Oracle-ranking and bug analysis will lean on "
              f"description + comments instead -- read those carefully rather than assuming "
              f"less evidence exists than actually does.")

    print(f"[2/6] Locating the fix in git (nd_device_services / nd_core_utils / nd_test_bot) ...")
    fix_location = locate_fix(ticket, repos_dir)
    n_commits = sum(len(v["matching_commits"]) for v in fix_location["repos"].values())
    print(f"      {len(fix_location['repos'])} repo(s), {n_commits} matching commit(s)")

    print(f"[2b/6] Checking Jira's Development panel for authoritative linked PRs ...")
    dev_status_prs = fetch_dev_status(env, ticket)
    if dev_status_prs:
        print(f"      {len(dev_status_prs)} linked PR(s): "
              + ", ".join(f"{p['id']}({p['status']})" for p in dev_status_prs))
        dev_status_prs = [pr_diff(pr, repos_dir) for pr in dev_status_prs]
        for pr in dev_status_prs:
            if pr.get("unavailable"):
                print(f"      WARNING: {pr['id']} {pr['repository']} -- {pr['unavailable']}")
            else:
                print(f"      ok  {pr['id']} {pr['repository']} {pr['source_branch']} -> "
                      f"{pr['destination_branch']}: real diff captured "
                      f"({len(pr['diff'])} chars{', truncated' if pr['diff_truncated'] else ''})")
    else:
        print(f"      no linked PRs found via dev-status (Development panel empty or "
              f"integration not configured for this project) -- falling back to git-grep only")

    print(f"[2c/6] Checking Jira's Linked Work Items for linked TestCase (TC) tickets ...")
    linked_test_cases = fetch_linked_test_cases(env, bug["linked_tests"], args.refresh)
    if linked_test_cases:
        print(f"      {len(linked_test_cases)} linked TestCase ticket(s): "
              + ", ".join(lt["key"] for lt in linked_test_cases)
              + " -- read these before designing the candidate, they can outrank the PR diff")
    else:
        print(f"      no linked TestCase tickets found (Linked Work Items empty, or none typed "
              f"'Test') -- design from the PR diff and ticket text alone")

    print(f"[3/6] Extracting log-based oracle candidates ...")
    oracle_candidates = extract_oracle_candidates(ticket, fix_location, bug, repos_dir)
    print(f"      {len(oracle_candidates)} candidate log lines ranked by relevance")

    print(f"[4/6] Building DSL capability manifest for {branch} ...")
    manifest = build_manifest(test_bot, branch)
    n_methods = sum(len(v["methods"]) for v in manifest.values())
    print(f"      {len(manifest)} objects, {n_methods} methods")

    print(f"[5/6] Loading test registry (main_db.xlsx) for {branch} ...")
    registry = build_registry(test_bot, branch)
    print(f"      {len(registry)} tests")

    print(f"[6/6] Inferring component + scoring coverage ...")
    comp = infer_components(bug, registry)
    component_names = [c["folder"] for c in comp["candidates"]]
    mapping = coverage_mapping(bug, registry, component_names)
    print(f"      component inference: {comp['method']} -> {component_names or '(none)'}")
    if mapping["top_matches"]:
        print(f"      best existing-test match: {mapping['top_matches'][0]['score']*100:.1f}% "
              f"{mapping['top_matches'][0]['file']}")

    bundle = {
        "schema_version": "1.0",
        "ticket": ticket,
        "target_branch": branch,
        "bug": bug,
        "fix_location": fix_location,
        "dev_status_prs": dev_status_prs,
        "linked_test_cases": linked_test_cases,
        "oracle_candidates": oracle_candidates,
        "manifest_summary": {"objects": len(manifest), "methods": n_methods,
                              "cache": f"out/_cache/manifest/{branch.replace('/', '_')}.json"},
        "registry_summary": {"tests": len(registry),
                              "cache": f"out/_cache/registry/{branch.replace('/', '_')}.json"},
        "component_inference": comp,
        "coverage_mapping": mapping,
        "next_step": "This bundle is deterministic evidence only. Feed it to the AI analysis "
                      "step (bug_analysis.json) and candidate generation step (the .py test), "
                      "then run out/validate_candidate.py on the result.",
    }

    out_dir = ROOT / "out" / ticket
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "research_bundle.json").write_text(json.dumps(bundle, indent=1))

    md = [f"# Research bundle -- {ticket}", "", f"**{bug['summary']}**", "",
          f"- Status: {bug['status']}  |  Priority: {bug['priority']}  |  Labels: {', '.join(bug['labels'])}",
          f"- Fix versions: {', '.join(bug['fix_versions'])}",
          f"- Linked Test tickets: {', '.join(t['key'] for t in bug['linked_tests']) or '(none)'}",
          "", "## Root cause",
          bug["root_cause"] or ("_(field empty -- this project may not use 'Root Cause "
                                 "Description' as a field name; read Description + comments "
                                 "below instead of assuming there's no evidence)_"
                                 if not bug["resolution"] else "_(field empty)_"),
          "", "## Resolution",
          bug["resolution"] or ("_(field empty -- see note under Root cause above)_"
                                 if not bug["root_cause"] else "_(field empty)_"),
          "", "## Description", bug["description"] or "_(field empty)_",
          "", "## Fix located in git",
          json.dumps(fix_location, indent=1) if n_commits else "_(no matching branch or commit found -- "
                                                                  "code change could not be located automatically)_",
          "", "## Linked PRs (Jira Development panel, authoritative)",
          "\n".join(f"- {p['id']} `{p['repository']}` {p['source_branch']} -> {p['destination_branch']} "
                     f"[{p['status']}]" + (f" -- NO DIFF: {p['unavailable']}" if p.get("unavailable") else " -- diff captured")
                     for p in dev_status_prs) or "_(none linked)_",
          "", "## Linked TestCase tickets (Linked Work Items -- read before designing the "
              "candidate, can outrank the PR diff)",
          "\n\n".join(
              f"### {lt['key']}: {lt.get('summary', '')}\n"
              f"- Product/Service: {lt.get('product_supported') or '-'} / {lt.get('service_component') or '-'}\n"
              f"**Preconditions**\n{lt.get('preconditions') or '_(empty)_'}\n\n"
              f"**Steps**\n{lt.get('steps') or '_(empty)_'}\n\n"
              f"**Expected Result**\n{lt.get('expected_result') or '_(empty)_'}\n\n"
              f"**Description** (the ticket's own free-text description -- read this even when "
              f"the structured fields above look populated; a tester sometimes writes \"see "
              f"description\" in them instead of duplicating the real content)\n"
              f"{lt.get('description') or '_(empty)_'}\n\n"
              f"**Attachments**\n" + (
                  "\n".join(
                      f"- {a['filename']} ({a.get('size') or '?'} bytes)"
                      + (f"\n  ```\n{a['text']}\n  ```" if a.get("text") else " -- binary/non-text, not fetched, open manually: " + str(a.get("url")))
                      for a in lt.get("attachments", [])
                  ) or "_(none)_"
              )
              for lt in linked_test_cases
          ) or "_(none linked)_",
          "", "## Oracle candidates (log lines, ranked by relevance)",
          "\n".join(f"- `{c['log_format']}`  "
                     f"(in `{c['enclosing_function']}()`, {c['repo']}@{c['commit'][:8]} {c['file']})"
                     for c in oracle_candidates[:10]) or "_(none found)_",
          "", "## Component inference", json.dumps(comp, indent=1),
          "", "## Coverage mapping (top matches)", json.dumps(mapping["top_matches"], indent=1),
          ]
    (out_dir / "research_bundle.md").write_text("\n".join(md))

    print()
    print(f"Wrote {out_dir / 'research_bundle.json'}")
    print(f"Wrote {out_dir / 'research_bundle.md'}")
    if not n_commits:
        print()
        print("NOTE: no code change was located automatically for this ticket. Bug intelligence "
              "and any generated test will rely on Jira text only -- expect Tier B/C/D, not Tier A.")


if __name__ == "__main__":
    main()
