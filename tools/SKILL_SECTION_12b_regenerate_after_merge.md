<!--
PROPOSED addition to .claude/skills/bug-regression/SKILL.md. NOT applied.

Claude may not edit the skill's own instructions, so paste this by hand, inside section 12
("Dashboard-driven stages"), directly after the `include` stage and before the line
"## Standing safety rules". Also change the argument line at the top of section 12 to read
`dashboard-stage=<generate|validate|include|regenerate>`.

tools/tc_worker.py refuses to run a regenerate job until SKILL.md contains the heading
"Regenerate after merge". Delete this comment when pasting.
-->

### Stage `regenerate` (Regenerate after merge)

Started from the dashboard on a ticket whose testcases already exist, usually because they were
written while the fix PRs were still open. The job is to find out whether the merged fix still
matches them, and to correct them if it does not. **No device, no repo write, no Jira write, no
commit, no push.** Arguments: `dashboard-stage=regenerate ticket=<DT-XXXX> job=<id> result-file=<path>`.

Precondition: `out/<ticket>/TC_*.py` and `out/<ticket>/bug_analysis.json` exist. If not,
`failed`: "testcases have not been generated".

1. **Re-gather evidence**: run `bugreg_research.py` for the ticket again (Step 1) so the PR states
   and diffs are current. It only diffs MERGED PRs; for a PR that is still open, read its branch
   against its target yourself, as the first generation had to.
2. **Compare with what the testcases were based on.** `bug_analysis.json` records the fix PRs and
   their state at generation time. List what changed since: a PR merged, a PR declined, a new PR
   linked, a PR's head commit moved, the ticket's description or linked TC ticket changed.
   - **Nothing is merged or declined yet and no PR moved** (every PR that was open is still open at
     the same commit): change nothing, write `"outcome": "not_merged"`, and say which PRs are
     still open. Do not rewrite a test only to make it look fresh.
3. **Read the merged diff line by line** (§2), then check every existing testcase against it, one
   by one:
   - Oracle log lines: still present, verbatim, in the merged source? Renamed or reworded in review?
   - Config keys, message names, method names, thresholds, service names: still what the test uses?
   - Scenarios: did review add a case the ticket now covers (write it), drop one the merged code no
     longer has (retire it), or change the expected behaviour (fix the oracle)?
   - A DECLINED PR the test was based on means the test was written against code that did not ship:
     say so, and rebuild it from the PR that did.
   - Re-run the §2 duplicate check: did someone add a test since that now covers this?
4. **If every testcase is still correct, change nothing.** Write `"outcome": "unchanged"`. Record
   in `bug_analysis.json` under `regeneration` the date, the PR states you checked against and the
   commits, so the next regenerate starts from there.
5. **If something is wrong or missing, edit in place:**
   - Keep each file's name and TC id when its scenario is the same. Rename only if its scope
     really changed, and say why.
   - New scenarios get new files, written to the same standard as a first generation (§3: coverage
     bar, family gate, step comments, one-line docstring, no narrative in the file).
   - A testcase the merged code makes meaningless is moved to `out/<ticket>/retired/`, not deleted,
     and the reason goes in `bug_analysis.json`.
   - Never weaken an oracle to keep an old test passing. If the merged behaviour differs from what
     the test expects, the test is what changes.
   - Run `validate_candidate.py` (Step 4) on every file you changed or added; fix and re-run until
     it passes. Do not leave a file that fails it.
   - Update `bug_analysis.json`: a `regeneration` entry (date, PR states, what changed and why,
     what stayed the same), and correct any sections the merge made untrue.
   - **Do not edit or delete `device_validation`.** The worker moves it aside to
     `superseded_device_validation` itself when it sees the testcase files changed, so the earlier
     device run is kept as history but no longer counts.
6. If a changed testcase was already deployed or pushed to a branch (`bug_analysis.json` or the
   ticket's Jira TC subtasks say so), do not touch that copy: it is a human's to reconcile. Say in
   `summary` which testcase and where.

Result: `"outcome"` is one of `"updated"`, `"unchanged"`, `"not_merged"`, `"failed"`, plus
`"summary"`: three to five plain sentences naming which PRs you compared against and exactly which
testcases changed and why. The worker decides updated versus unchanged from the files on disk, so
report what is true. If you cannot finish (evidence unreachable, validation cannot be made to
pass), `"outcome": "failed"` and the reason; the worker puts the testcase files back as they were.
