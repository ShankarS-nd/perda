<!--
PROPOSED addition to .claude/skills/bug-regression/SKILL.md. NOT applied.

Claude was not permitted to edit the skill's own instructions, so this has to be pasted in by
hand. Put it just above "## Standing safety rules", after section 11. tools/tc_worker.py refuses
to start until SKILL.md contains the heading "Dashboard-driven stages".

Three existing sentences in SKILL.md say "never commit / never push". They stay true except for
the `include` stage below; add "(except the dashboard include stage, §12)" to each if you want
the file to be consistent:
  - "The one sentence that governs everything else": "...never auto-commits, never auto-pushes..."
  - §11: "Never commit, never push, never merge..."
  - Standing safety rules: "Never commit or push git changes in the target repos."
-->

## 12. Dashboard-driven stages

The perda dashboard (Release Tickets, Team status columns) starts this skill unattended through
the claude CLI, one stage at a time, with arguments of this shape:

```
dashboard-stage=<generate|validate|include> ticket=<DT-XXXX> job=<id> result-file=<path>
    [device=<id>] [unfixed-device=<id>] [base-branch=<branch>]
```

**When `dashboard-stage=` is present, this section governs the run.** Do that one stage and
nothing after it. Nobody is watching and nobody can answer, so never stop to ask a question:
anything you would have asked becomes either a documented gap or a `failed` result. Everything
else in this file still applies (the coverage bar, the DSL mechanics, the safety rules), with only
the exceptions written out below.

**Always finish by writing the result file**, as JSON, at the exact `result-file` path. The
dashboard reads only that file; a run that ends without it is treated as failed. Common fields:
`{"outcome": "...", "summary": "<2-4 plain sentences a teammate can read on the dashboard>"}`.
Never put a password in it. The worker independently checks what you report (files on disk, the
branch on origin), so report only what is true.

**Check the previous stage first, on disk, and refuse to go on if it is not complete.** The
dashboard checks its own status column, but that column can be edited by hand.

### Stage `generate` (Generated TCs)

Run Steps 1-4 for the ticket, exactly as for a ticket-key invocation. Stop after static
validation passes; do not deploy and do not touch a device.

- Candidates written and passing `validate_candidate.py`: `"outcome": "generated"`, plus
  `"testcases": ["TC_....py", ...]`.
- The mandatory duplicate check (§2) found an existing test that already covers the regression:
  write no candidate; `"outcome": "covered"`, `"covered_by": "<file>"`, and say why in `summary`.
- Anything else (project root not set up, no usable evidence, validation cannot be made to pass
  honestly): `"outcome": "failed"` with the reason.

### Stage `validate` (Validated in device)

Precondition: `out/<ticket>/TC_*.py` and `out/<ticket>/bug_analysis.json` exist. If not,
`failed`: "testcases have not been generated".

- **The human review of Step 6 has happened**: the dashboard shows the generated testcases and
  the person who pressed Validate confirmed they reviewed them. Proceed to Steps 7-10.
- **Device passwords come from the environment, not from a question**:
  `BUGREG_DEVICE_PASSWORD` for `device=`, `BUGREG_UNFIXED_DEVICE_PASSWORD` for
  `unfixed-device=`. They were typed in for this run, so they are current. Refer to them as
  `"$BUGREG_DEVICE_PASSWORD"` inside commands (for example `SSHPASS="$BUGREG_DEVICE_PASSWORD"
  sshpass -e ssh ...`). Never `echo` or print them, and never write them to `out/`,
  `bug_analysis.json`, the result file, or anything that gets committed. Writing the password into
  the local checkout's `src/parameters/parameters.json` is allowed when the framework needs it
  there to run; that file is never committed by this skill.
- `device=` is the device **with** the fix: Steps 7, 8 and 9 on it. If `unfixed-device=` is given,
  also Step 10 on it. If it is not given, skip Step 10 and record that in `bug_analysis.json` as a
  documented gap.
- Record the runs in `bug_analysis.json` under `device_validation` (always, pass or fail).
- Result `outcome`:
  - `"yes"`: genuine pass on the fixed device AND a correct, right-reason fail on the unfixed one.
  - `"partial"`: genuine pass on the fixed device; no unfixed device given, or Step 10 inconclusive.
  - `"no"`: the candidate does not pass on the fixed device and the cause is not something you
    could legitimately fix in this run. Say which of the three failure kinds (§9) it is.
  - `"failed"`: the run could not happen at all (device unreachable, wrong password, TC ticket
    could not be created, ...).
  Also include `"device"`, `"unfixed_device"` (if any) and `"testcases"` (final filenames, after
  the §7 rename).

### Stage `include` (Included in runs) — the one place this skill commits and pushes

Precondition: `bug_analysis.json` has a `device_validation` section showing a genuine pass on a
device with the fix. If not, `failed`: "not validated on a device". Include only candidates that
passed; name any you left out in `summary`.

**This stage is an explicit, standing authorisation from the user to commit and push, limited to
exactly this:** one new branch in `nd_test_bot`, created from `base-branch`, containing only the
validated testcase files and their `main_db.xlsx` rows, pushed to `origin` under its new name.
Every other rule stands: never push to `base-branch` or any existing branch, never force-push,
never merge, never open a pull request, never touch another repo, never change Jira.

1. `cd repos/nd_test_bot && git fetch origin <base-branch>`. If the branch is not on origin: `failed`.
2. New branch name: `bugreg/<ticket>-on-<base-branch with "/" replaced by "-">`. If that name
   already exists on origin (`git ls-remote --heads origin <name>`), append `-2`, `-3`, ...
3. Work in a separate worktree so the shared checkout is never switched, stashed or reset:
   `git worktree add -b <new-branch> <project-root>/out/<ticket>/.dashboard/wt_<job> origin/<base-branch>`
4. Deploy each validated candidate into the worktree with the bundled script (it re-runs the
   validation gates and adds the `main_db.xlsx` row by header name):
   `python3 <this-skill-dir>/scripts/promote_candidate.py out/<ticket>/TC_....py --branch <base-branch> --test-bot-dir <worktree>`
   If it refuses because the file already exists on `base-branch`, that testcase is already
   included: leave it out and say so. If nothing is left to include: `failed`, "already on
   <base-branch>".
5. In the worktree, `git add` exactly the deployed testcase files and `main_db.xlsx`, by path.
   Check `git status --porcelain` shows nothing else staged or modified (in particular no
   `parameters.json`). Commit: `<ticket>: add regression testcase(s) TC_<id>[, TC_<id>...]`.
6. `git push origin <new-branch>` (plain push, no `--force`). Confirm with
   `git ls-remote --heads origin <new-branch>`.
7. `git worktree remove <worktree>` (the local branch stays).
8. Result: `"outcome": "pushed"`, `"branch": "<new-branch>"`, `"base_branch"`, `"commit"` (sha),
   `"testcases"`. The rows stay `Remark = "candidate, pending review"`: merging the branch and
   promoting the rows remain human decisions.
