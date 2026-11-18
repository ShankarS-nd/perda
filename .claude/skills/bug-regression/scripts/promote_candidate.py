#!/usr/bin/env python3
"""
promote_candidate.py -- deploy a validated candidate test into the framework and register it
in main_db.xlsx, in one command instead of a manual `cp` plus a manual openpyxl snippet each time.

This does NOT replace the human-review checkpoint (docs/USAGE_GUIDE.md Step 6) -- it's meant to
be run AFTER a human has looked at the candidate, not instead of that. It re-runs
validate_candidate.py's own gates internally first and REFUSES to deploy anything that fails
them -- same protection as running validate_candidate.py separately, just as one command instead
of two.

Usage:
  python3 promote_candidate.py <candidate.py> --branch <branch> \
      [--time-seconds N] [--project-root PATH]

Writes (relative to the resolved project root):
  repos/nd_test_bot/Test_Automation_Framework/src/test_cases/<SERVICE>/<file>
  a new row in repos/nd_test_bot/Test_Automation_Framework/main_db.xlsx
    (Remark: "candidate, pending review" -- this script never promotes anything further than that)

Project root resolution: --project-root flag, then $BUGREG_PROJECT_ROOT, then cwd -- same
convention as bugreg_research.py / validate_candidate.py.
"""
import argparse
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_candidate as vc

MAIN_DB_COLUMNS_NOTE = (
    # file_name, description, time_in_seconds, isChildCase, retry, Stable, 6.8..6.16_Stable(8 cols),
    # 6.12_Bugs, DevPackage_Required, QA_Stable, Remark, Service_name
    # retry/isChildCase left blank on purpose -- "No" breaks a downstream int(retry) call
    # (verified against ~400 real rows, see docs/SESSION_LEARNINGS.md §3.9)
)


def derive_service_folder(filename):
    m = re.match(r"^TC_(\d+)_([A-Z0-9-]+)_", filename)
    if not m:
        raise SystemExit(f"filename {filename!r} does not match TC_<id>_<SERVICE>_<NAME>.py "
                          f"-- refusing to guess a service folder")
    return m.group(1), m.group(2)


def derive_description(candidate_path):
    """Pull the candidate's own docstring and collapse it to one line -- current-convention
    candidates carry a single one-line docstring already; older multi-paragraph docstrings
    are truncated to their opening paragraph so the description column stays one line."""
    text = Path(candidate_path).read_text()
    m = re.match(r'\s*"""(.*?)"""', text, re.S)
    if not m:
        return Path(candidate_path).stem
    body = m.group(1).strip()
    first_para = body.split("\n\n", 1)[0]
    return " ".join(first_para.split())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("candidate", help="path to the candidate .py file")
    ap.add_argument("--branch", required=True, help="nd_test_bot branch this deploys to")
    ap.add_argument("--time-seconds", type=int, default=300,
                     help="main_db.xlsx time_in_seconds column (default: 300)")
    ap.add_argument("--project-root", default=None)
    ap.add_argument("--test-bot-dir", default=None,
                     help="deploy into this nd_test_bot checkout or worktree instead of "
                          "<project-root>/repos/nd_test_bot")
    args = ap.parse_args()

    project_root = (Path(args.project_root).resolve() if args.project_root
                     else Path(os.environ.get("BUGREG_PROJECT_ROOT", ".")).resolve())
    repos_dir = project_root / "repos"
    test_bot = Path(args.test_bot_dir).resolve() if args.test_bot_dir else repos_dir / "nd_test_bot"
    framework = test_bot / "Test_Automation_Framework"
    branch = args.branch if args.branch.startswith("origin/") else f"origin/{args.branch}"

    if not framework.is_dir():
        raise SystemExit(f"No nd_test_bot checkout at {test_bot} -- run this from your project "
                          f"root, or pass --project-root.")

    candidate_path = Path(args.candidate).resolve()
    if not candidate_path.is_file():
        raise SystemExit(f"No such file: {candidate_path}")
    filename = candidate_path.name
    tc_id, service = derive_service_folder(filename)

    manifest_path = project_root / "out" / "_cache" / "manifest" / f"{branch.replace('/', '_')}.json"
    if not manifest_path.is_file():
        raise SystemExit(f"No manifest cache at {manifest_path} -- run bugreg_research.py for "
                          f"this branch first (it builds and caches this).")

    print(f"[1/3] Re-validating {filename} against {branch} before deploying ...")
    r = vc.run_gates(str(candidate_path), str(manifest_path), service, branch, repo=str(test_bot))
    if r.errors:
        print()
        for e in r.errors:
            print(f"FAIL  {e}")
        raise SystemExit(f"\nREFUSING TO DEPLOY -- {len(r.errors)} validation error(s) above. "
                          f"Fix them and re-run -- this is the exact same check "
                          f"validate_candidate.py would give you separately, just enforced here "
                          f"too so a bad candidate can't skip straight to deployment.")
    if r.warnings:
        for w in r.warnings:
            print(f"WARN  {w}")
    print(f"      passed all gates ({len(r.warnings)} warning(s))")

    dest_dir = framework / "src" / "test_cases" / service
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    if dest.exists():
        raise SystemExit(f"REFUSING TO OVERWRITE -- {dest} already exists. If this is an "
                          f"intentional update to an existing candidate, remove/rename it first "
                          f"and re-run; this script never silently overwrites a deployed test.")
    dest.write_bytes(candidate_path.read_bytes())
    print(f"[2/3] Deployed -> {dest}")

    description = derive_description(candidate_path)
    main_db_path = framework / "main_db.xlsx"
    import openpyxl
    wb = openpyxl.load_workbook(main_db_path)
    ws = wb.active

    # Append BY HEADER NAME, never by position. The workbook's real column set and order drift
    # (it currently has 21 columns including 6.13_Stable/6.15_Stable and puts 6.12_Bugs in the
    # middle); a fixed positional list silently lands Remark in DevPackage_Required and
    # Service_name in QA_Stable, which breaks both candidate-marking and -t <SERVICE> selection.
    headers = [c.value for c in next(ws.iter_rows(min_row=1, max_row=1))]
    values = {
        "file_name": filename,
        "description": description,
        "time_in_seconds": args.time_seconds,
        "isChildCase": None,   # blank, not "No" (see MAIN_DB_COLUMNS_NOTE above)
        "retry": None,         # blank, not "No" -- "No" breaks a downstream int(retry)
        "Stable": "No",
        "QA_Stable": None,     # left blank, as on real rows -- QA has not looked at it yet
        "Remark": "candidate, pending review",  # what actually marks "not yet approved"
        "Service_name": service,
    }
    # Every per-version <x.y>_Stable column present in this workbook gets an honest "No".
    # Matched on a leading digit so QA_Stable and any future non-version *_Stable column are
    # not swept in -- those stay blank unless mapped explicitly above.
    for h in headers:
        if isinstance(h, str) and h.endswith("_Stable") and h[:1].isdigit() and h not in values:
            values[h] = "No"

    unknown = [k for k in values if k not in headers]
    if unknown:
        raise SystemExit(f"main_db.xlsx has no column(s) named {unknown} -- its schema changed. "
                          f"Refusing to append a row that would land values in the wrong columns; "
                          f"update this script's `values` mapping to match the real headers: "
                          f"{headers}")

    ws.append([values.get(h) for h in headers])
    wb.save(main_db_path)
    print(f"[3/3] Added main_db.xlsx row for TC_{tc_id} (Remark: candidate, pending review)")
    print()
    print(f"NOTE: this is still a CANDIDATE, same as if you'd done the cp + xlsx edit by hand. "
          f"Nothing here promotes it further, files a Jira ticket, or commits/pushes anything.")


if __name__ == "__main__":
    main()
