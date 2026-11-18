#!/usr/bin/env python3
"""
create_tc_ticket.py -- create the Jira TC subtask a candidate testcase needs before it can be
run on a real device, under the TC project's "Testcases for ... using claude skill" story.

Why this exists: the DTA framework derives a run's Jira key FROM THE TESTCASE FILENAME. A
`TC_<id>_...py` whose id has no matching Jira TC ticket makes a genuinely-passing run get
reported back as "Not Executed", and an id that belongs to somebody else's ticket silently
mis-attributes the result to unrelated work. So the ticket has to exist, with the right id,
BEFORE the first real-device run -- not after it.

Idempotent: if the parent already has a subtask whose summary matches this candidate, it
reports that key and creates nothing. Safe to re-run.

Usage:
  # normal: derive everything from the candidate path, create the subtask, rename the file
  python3 create_tc_ticket.py out/DT-1234/TC_9999_BAGHEERA_VERIFY_SOMETHING.py

  # look first, change nothing
  python3 create_tc_ticket.py out/DT-1234/TC_9999_BAGHEERA_VERIFY_SOMETHING.py --dry-run

  # override the parent story / source ticket, or keep the local filename as-is
  python3 create_tc_ticket.py <candidate.py> --parent TC-4574 --source DT-1234 --no-rename

Reads JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN from <project-root>/.env, the same file
bugreg_research.py uses. Project root: --project-root, then $BUGREG_PROJECT_ROOT, then cwd.

This script creates ONE Jira subtask and (by default) renames the local candidate file to match
the key it got back. It never transitions a ticket, never comments, never edits main_db.xlsx,
never touches a deployed copy in repos/, and never commits anything.
"""
import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_PARENT = "TC-4574"
SUBTASK_ISSUETYPE_NAME = "Subtask"

FILENAME_RE = re.compile(r"^TC_(\d+)_([A-Z0-9-]+)_(.+)\.py$")


# ---------------------------------------------------------------------------
# env / http  (same conventions as bugreg_research.py)
# ---------------------------------------------------------------------------

def load_env(project_root):
    env_path = project_root / ".env"
    if not env_path.is_file():
        raise SystemExit(f"No .env at {env_path} -- this script needs JIRA_BASE_URL, JIRA_EMAIL "
                         f"and JIRA_API_TOKEN, the same ones bugreg_research.py uses.")
    env = {}
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for key in ("JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"):
        if not env.get(key):
            raise SystemExit(f"{key} missing from {env_path}")
    return env


def jira(env, path, method="GET", body=None):
    base = env["JIRA_BASE_URL"].rstrip("/")
    auth = base64.b64encode(f"{env['JIRA_EMAIL']}:{env['JIRA_API_TOKEN']}".encode()).decode()
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"Authorization": "Basic " + auth,
                 "Accept": "application/json",
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        detail = e.read()[:1000].decode("utf8", "ignore")
        return e.code, {"_error": detail}
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise SystemExit(f"Could not reach {base}: {e} -- network/VPN problem on this machine, "
                         f"not a Jira or script problem. Fix connectivity and re-run.")


# ---------------------------------------------------------------------------
# candidate introspection
# ---------------------------------------------------------------------------

def parse_candidate(path):
    m = FILENAME_RE.match(path.name)
    if not m:
        raise SystemExit(f"filename {path.name!r} does not match TC_<id>_<SERVICE>_<NAME>.py -- "
                         f"refusing to guess a ticket summary from it")
    tc_id, service, name = m.group(1), m.group(2), m.group(3)
    # The established summary convention on TC-4574's existing subtasks is the filename with
    # the TC_<id>_ prefix and the .py suffix stripped, e.g.
    #   TC_4588_BAGHEERA_GEOFENCE_MARKER_GATES_GPS_PUBLISH_AND_RESUMES.py
    #   -> "BAGHEERA_GEOFENCE_MARKER_GATES_GPS_PUBLISH_AND_RESUMES"
    summary = f"{service}_{name}"
    return tc_id, service, summary


def candidate_purpose(path):
    """The candidate's one-line docstring, minus its leading 'DT-XXXX: ' -- used as the
    ticket description's human summary of what the test verifies."""
    text = path.read_text()
    m = re.match(r'\s*"""(.*?)"""', text, re.S)
    if not m:
        return ""
    body = " ".join(m.group(1).split())
    return re.sub(r"^[A-Z]+-\d+:\s*", "", body)


def derive_source_ticket(path, explicit):
    if explicit:
        return explicit.upper()
    # out/DT-1234/TC_....py -- the parent directory is the source bug ticket by convention
    m = re.match(r"^((?:DT|OCTO)-\d+)$", path.parent.name, re.I)
    if m:
        return m.group(1).upper()
    m = re.search(r"\b((?:DT|OCTO)-\d+)\b", path.read_text()[:600], re.I)
    if m:
        return m.group(1).upper()
    raise SystemExit(f"Could not work out the source bug ticket for {path.name} -- pass "
                     f"--source DT-XXXX explicitly rather than letting this guess.")


def build_description(env, source_ticket, service, purpose):
    base = env["JIRA_BASE_URL"].rstrip("/")
    content = [
        {"type": "paragraph", "content": [
            {"type": "text", "text": "Automated regression testcase for "},
            {"type": "inlineCard", "attrs": {"url": f"{base}/browse/{source_ticket}"}},
            {"type": "text", "text": "."},
        ]},
    ]
    if purpose:
        content.append({"type": "paragraph",
                        "content": [{"type": "text", "text": purpose}]})
    content.append({"type": "paragraph", "content": [{"type": "text", "text":
        f"Generated by the bug-regression pipeline and deployed to nd_test_bot "
        f"(src/test_cases/{service}/). The testcase file is named after this ticket's id -- the "
        f"framework derives the Jira key from the filename, so the two must stay in sync."}]})
    return {"type": "doc", "version": 1, "content": content}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def find_existing_subtask(env, parent, summary):
    status, data = jira(env, f"/rest/api/3/issue/{parent}"
                             f"?fields=summary,subtasks,issuetype,project")
    if status != 200:
        raise SystemExit(f"Could not read parent {parent} (HTTP {status}): "
                         f"{data.get('_error', data)}")
    if data["fields"]["issuetype"]["subtask"]:
        raise SystemExit(f"{parent} is itself a Subtask -- Jira does not allow subtasks of "
                         f"subtasks. Pass a Story/Task as --parent.")
    wanted = summary.strip().upper()
    for st in data["fields"]["subtasks"]:
        if st["fields"]["summary"].strip().upper() == wanted:
            return data, st["key"]
    return data, None


def rename_candidate(path, new_id, old_id):
    new_name = path.name.replace(f"TC_{old_id}_", f"TC_{new_id}_", 1)
    new_path = path.with_name(new_name)
    if new_path.exists():
        raise SystemExit(f"Wanted to rename {path.name} -> {new_name} but that file already "
                         f"exists. Sort out which one is real by hand; refusing to overwrite.")
    path.rename(new_path)
    return new_path


def warn_if_already_deployed(project_root, service, old_name):
    """A deployed copy / main_db row under the OLD id is now wrong, and fixing either one
    automatically would mean editing a shared checkout and the registry -- so report it
    loudly and let a human do it instead."""
    problems = []
    deployed = (project_root / "repos" / "nd_test_bot" / "Test_Automation_Framework"
                / "src" / "test_cases" / service / old_name)
    if deployed.is_file():
        problems.append(f"a deployed copy at {deployed}")
    main_db = (project_root / "repos" / "nd_test_bot" / "Test_Automation_Framework"
               / "main_db.xlsx")
    if main_db.is_file():
        try:
            import openpyxl
            wb = openpyxl.load_workbook(main_db, read_only=True)
            for row in wb.active.iter_rows(min_col=1, max_col=1, values_only=True):
                if row[0] == old_name:
                    problems.append(f"a main_db.xlsx row for {old_name}")
                    break
            wb.close()
        except Exception as e:                       # registry unreadable is not fatal here
            problems.append(f"(could not check main_db.xlsx: {e})")
    return problems


def update_bug_analysis(path, key, url, parent):
    analysis = path.parent / "bug_analysis.json"
    if not analysis.is_file():
        return None
    try:
        data = json.loads(analysis.read_text())
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    entry = {"key": key, "url": url, "parent": parent, "testcase_file": path.name}
    existing = data.get("jira_tc_subtasks")
    if isinstance(existing, list):
        existing = [e for e in existing
                    if not (isinstance(e, dict) and e.get("key") == key)]
        existing.append(entry)
        data["jira_tc_subtasks"] = existing
    else:
        data["jira_tc_subtasks"] = [entry]
    analysis.write_text(json.dumps(data, indent=2) + "\n")
    return analysis


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("candidate", help="path to the candidate .py file")
    ap.add_argument("--parent", default=DEFAULT_PARENT,
                    help=f"parent story to create the subtask under (default: {DEFAULT_PARENT})")
    ap.add_argument("--source", default=None,
                    help="source bug ticket (default: derived from the out/<TICKET>/ folder)")
    ap.add_argument("--no-rename", action="store_true",
                    help="do not rename the local candidate to the id Jira handed back "
                         "(you then MUST reconcile the filename yourself before running it)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print exactly what would be created, create nothing")
    ap.add_argument("--project-root", default=None)
    args = ap.parse_args()

    project_root = (Path(args.project_root).resolve() if args.project_root
                    else Path(os.environ.get("BUGREG_PROJECT_ROOT", ".")).resolve())
    env = load_env(project_root)
    base = env["JIRA_BASE_URL"].rstrip("/")

    path = Path(args.candidate).resolve()
    if not path.is_file():
        raise SystemExit(f"No such file: {path}")
    old_id, service, summary = parse_candidate(path)
    source_ticket = derive_source_ticket(path, args.source)
    purpose = candidate_purpose(path)
    parent = args.parent.upper()

    print(f"[1/3] Checking {parent} for an existing subtask named {summary!r} ...")
    parent_issue, existing = find_existing_subtask(env, parent, summary)
    print(f"      parent: {parent} ({parent_issue['fields']['summary']!r}), "
          f"project {parent_issue['fields']['project']['key']}, "
          f"{len(parent_issue['fields']['subtasks'])} existing subtask(s)")

    if existing:
        new_id = existing.split("-")[1]
        print(f"      already exists: {existing} -- {base}/browse/{existing}")
        print(f"[2/3] Nothing created (idempotent re-run).")
    elif args.dry_run:
        print(f"[2/3] DRY RUN -- would create a {SUBTASK_ISSUETYPE_NAME} under {parent}:")
        print(f"        summary:     {summary}")
        print(f"        source bug:  {source_ticket}")
        print(f"        description: Automated regression testcase for {source_ticket}. "
              f"{purpose[:120]}{'...' if len(purpose) > 120 else ''}")
        print(f"      and would rename TC_{old_id}_... to the id Jira returns.")
        return
    else:
        body = {"fields": {
            "project": {"key": parent_issue["fields"]["project"]["key"]},
            "parent": {"key": parent},
            "issuetype": {"name": SUBTASK_ISSUETYPE_NAME},
            "summary": summary,
            "description": build_description(env, source_ticket, service, purpose),
        }}
        status, data = jira(env, "/rest/api/3/issue", method="POST", body=body)
        if status not in (200, 201):
            raise SystemExit(f"Jira refused to create the subtask (HTTP {status}): "
                             f"{data.get('_error', data)}")
        existing = data["key"]
        new_id = existing.split("-")[1]
        print(f"[2/3] Created {existing} -- {base}/browse/{existing}")

    if args.dry_run:
        return

    final_path = path
    if new_id != old_id and not args.no_rename:
        problems = warn_if_already_deployed(project_root, service, path.name)
        final_path = rename_candidate(path, new_id, old_id)
        print(f"[3/3] Renamed candidate -> {final_path.name} (filename id now matches {existing})")
        if problems:
            print()
            print(f"ATTENTION -- the OLD id TC_{old_id} is already registered/deployed:")
            for p in problems:
                print(f"  - {p}")
            print(f"  A run picked up from either of those still reports against TC-{old_id}. "
                  f"Remove them and re-run promote_candidate.py with the renamed file before "
                  f"the device run. Not done automatically: both live in the shared checkout.")
    elif new_id != old_id:
        print(f"[3/3] --no-rename given: file is still TC_{old_id}_... but the ticket is "
              f"{existing}. Results from this file will be attributed to TC-{old_id}. "
              f"Reconcile before running it on a device.")
    else:
        print(f"[3/3] Filename id TC_{old_id} already matches {existing} -- nothing to rename.")

    updated = update_bug_analysis(final_path, existing, f"{base}/browse/{existing}", parent)
    if updated:
        print(f"      recorded jira_tc_subtasks in {updated.name}")
    print()
    print(f"Ticket exists and the filename matches it -- the device run's result will now be "
          f"attributed to {existing} instead of reporting as Not Executed.")


if __name__ == "__main__":
    main()
