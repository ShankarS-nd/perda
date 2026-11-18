<!--
PROPOSED addition to .claude/skills/bug-regression/SKILL.md. NOT applied.

Claude may not edit the skill's own instructions, so paste this by hand, inside section 12
("Dashboard-driven stages"), directly after the `include` stage (after its step 8) and before
"### Stage `regenerate`". Also change the sentence in the `include` stage that says "never push to
`base-branch` or any existing branch" to end with: "... except in the `target-branch=` form below".
Add `target-branch=<branch>` to the argument line of section 12 as an alternative to `base-branch=`.

tools/tc_worker.py refuses an "Include into an existing branch" job until SKILL.md contains the
heading "Include into the given branch". Delete this comment when pasting.
-->

#### Include into the given branch (`target-branch=<branch>`)

Used instead of the steps above when the dashboard passes `target-branch=<branch>` and not
`base-branch=`. The user chose, and confirmed in the dashboard, to push the validated testcases
**into that existing branch**. That confirmation is a standing authorisation for exactly this and
nothing wider: one plain push of one commit to that one branch of `nd_test_bot`. Every other rule
stands: never force-push (no `--force`, no `--force-with-lease`, no `+refspec`), never delete or
rename a branch, never rewrite history, never merge, never open a pull request, never touch another
repo or another branch, never change Jira. `main` and `master` are never a target: if the argument
is one of them, `failed`.

1. `cd repos/nd_test_bot && git fetch origin <branch>`. If the branch is not on origin: `failed`.
   Remember its head sha (`git rev-parse origin/<branch>`) as `old_head`.
2. Work in a separate worktree so the shared checkout is never switched, stashed or reset:
   `git worktree add --detach <project-root>/out/<ticket>/.dashboard/wt_<job> origin/<branch>`
3. Deploy each validated candidate into the worktree exactly as in step 4 above
   (`promote_candidate.py ... --branch <branch> --test-bot-dir <worktree>`). A testcase that already
   exists on the branch is already included: leave it out and say so. If nothing is left: `failed`,
   "already on <branch>".
4. In the worktree `git add` exactly the deployed testcase files and `main_db.xlsx`, by path, and
   check `git status --porcelain` shows nothing else. Commit as `<ticket>: add regression testcase(s)
   TC_<id>[, TC_<id>...]`.
5. `git push origin HEAD:refs/heads/<branch>` (plain). If it is rejected because the branch moved:
   `git fetch origin <branch>`, `git rebase origin/<branch>` once, and push again. If it is rejected
   again, or the rebase conflicts, abort the rebase and report `failed` with the reason. Never force.
6. Confirm with `git ls-remote --heads origin <branch>` that the branch now points at your commit.
   If origin's HTTPS remote has no credentials in this session, push and fetch with the SSH form of
   the same URL, without changing the configured remote.
7. `git worktree remove <worktree>`.
8. Result: `"outcome": "pushed"`, `"branch": "<branch>"` (the same branch), `"commit"` (the full
   40-character sha you pushed), `"old_head"`, `"testcases"`, and a `"summary"` that says which
   testcases went in and which were left out and why. The rows stay `Remark = "candidate, pending
   review"`.

The worker checks all of this itself afterwards: the branch must be at your commit on the remote,
must have moved forward from `old_head`, and only testcase files and `main_db.xlsx` may differ.
