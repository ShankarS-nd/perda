# Session Log

Running memory of important work across Claude sessions: what was built, the result,
and the corrections made along the way. Newest session first. Keep entries short.

**How to use:** at the start of a session, read this file. At the end of meaningful work
(or when asked), add an entry using the template at the bottom.

---

## 2026-11-18 — Post-fix / pre-fix per testcase, device pre-checks
- Device pre-checks: before a validate job the worker logs in read-only (paramiko via `tools/device_check.py`)
  and runs `validation_requirements.fix_checks` Claude wrote (fix present on the fixed device, absent on the
  unfixed one, services on both). Commands are filtered to read-only. `skip_device_checks` overrides. A bug
  made the whole preflight a no-op (detect_device.py prints indented JSON, last line was parsed); fixed with
  `parse_device_info`. DT-5431 regenerated so its checks exist (3 checks).
- `unfixed_conclusive` per testcase: an unfixed failure for the wrong reason (missing service) no longer counts.
- Page: each testcase shows `post-fix ✓/–` and `pre-fix ✓/–`; Validated cell shows `post-fix N/M · pre-fix N/M`;
  the Include popup states which testcases lack post-fix or pre-fix evidence. Include already works on Partial
  once the open items are accepted. Page not yet looked at in a browser.

## 2026-11-17 — Release Checklist tab (not committed, not deployed)
**Goal:** a live checklist of release reports per platform (D450US, D215US), from the user's pasted sheet.
**Built:** table `release_checklist` (+ `_meta`) in `database.py` (created and seeded lazily, shared by all 4 workers), endpoints `GET/PUT /release-checklist`, `POST /release-checklist/reset` in `main.py`, `frontend/components/ReleaseChecklist.tsx` + sidebar entry. Cells are Pending/Done/N/A dropdowns with who/when; page polls every 5 s (paused when the tab is hidden); "New release (reset)" turns Done back to Pending, N/A stays. Items/platforms are constants in `database.py`.
**Assumption:** the sheet had one value for Data Bandwidth and Critical Event; seeded D450US = Done, D215US = Pending (not copied to D215US).
**Verified:** DB functions on a DB copy, 117 backend tests, tsc clean. NOT verified: UI in a browser. Needs backend restart + frontend build.

---

## 2026-11-18 — Per-testcase validation status on the page
- User wanted to see which testcase is fully validated and which partially. Evidence is now kept PER
  TESTCASE in `out/<dt>/.dashboard/validation_state.json` (`by_sha`, keyed by file content so the Jira
  rename keeps it and an edit drops it; the older ticket-wide file is migrated for single-testcase
  tickets only). Status per testcase: yes (pass with the fix AND fail without), partial (one half),
  failed, na, not_run. Ticket-level Validated is Yes only when EVERY testcase is yes.
- Claude is asked for `testcase_results` per file (fixed/unfixed pass|fail|na); without it the run-wide
  result applies to the testcases the run lists. Worker publishes the statuses with the requirements
  (`validation` map, sanitised by the backend). Page: Generated TCs chips are coloured (green ✓ full,
  amber ½ partial, red ✕ failed, grey NA, indigo – not validated) with a tooltip naming the devices;
  "N/M full" under Validated for multi-testcase tickets; testcase list in the Validate popup; remaining
  list gets one line per testcase that is not fully validated.
- DT-5429 backfilled from recorded evidence: TC_5667 partial (passed with the fix), TC_5680/5681 NA.
  DT-5319 and DT-5074 migrated to yes. 139 backend tests pass; backend and worker restarted (no job).
- Not verified with the real skill: Claude actually returning `testcase_results`.

---

## 2026-11-18 — Release Tickets: "At least one PR merged" filter (frontend only, not committed)
- New option in the Pull requests dropdown (`rt_pr=any-merged` in the URL): keeps tickets where any PR is
  MERGED, even if others are still open. The existing "All PRs merged" stays for the stricter case.
- Four bagheera3 devices checked/registered in ip_db: 103062502253, 103062502291, 103432407292 (already
  there) and 103452403622 (added, 172.16.17.54).

---

## 2026-11-17 — Remove testcases from a branch (5th action), restart done
- User included testcases by mistake and wants them out of the branch while the ticket stays validated.
  New action `remove` (button ✕ beside the ▶ in the Included in runs cell, only when the cell lists a
  branch): the WORKER does it with plain git, no model. It fetches the branch, works in a detached
  worktree, `git rm`s every file the ticket's testcases ever had (on disk + the Jira-renamed names in
  bug_analysis.json), deletes their rows from main_db.xlsx by file_name (openpyxl via the project .venv),
  commits and pushes plainly (never forced; rebases once if the branch moved), then checks the remote is
  at that commit, moved forward, and only testcase files / main_db.xlsx changed. Outcomes: removed, or
  absent (nothing of it was on the branch). The branch leaves the cell; Validated is untouched.
- Gates: branch must be listed in the cell, confirm box required, main/master refused, one include/remove
  per branch at a time. Real-git test with a local bare origin (history kept, other rows kept, work area
  cleaned, second run = absent). 136 backend tests pass.
- Backend + worker restarted (no job was running). Include INTO a branch still needs
  tools/SKILL_SECTION_12d pasted into SKILL.md; Remove does not need the skill.
- DT-5429 unfixed-only runs a5cc3a and b42d4c both ended before the oracle: device 103432407292 had
  bagheera stopped, then was running but not recording (no new file since 10 Oct), so nothing was shown.
  Validated stays Partial.

---

## 2026-11-17 — Include pushes INTO the branch the user gives (code done, NOT loaded, skill text pending)
- User: one branch given again and again must not make a new branch per DT. Old Include created
  `bugreg/<DT>-on-<base>` per ticket. New default in the popup: "Into this branch" (the other choice,
  "In a new branch from it", is the old behaviour and stays the API default for old callers).
- Backend: include params `branch` + `target` (existing|new); `existing` needs `confirm_push`, refuses
  main/master (also origin/main), and allows ONE active include per target branch (two pushes at once
  would race and main_db.xlsx cannot be merged by hand). Worker: refuses until SKILL.md has the heading
  "Include into the given branch"; fails early if the branch is not on the remote; after Claude reports,
  checks the remote branch is at the reported 40-char commit, moved forward from the head it had before
  the job, and that only src/test_cases/** and main_db.xlsx changed (a failure then says the push HAS
  happened). Popup: target radio, warning, required confirm box; result says "Pushed into".
- Skill: `tools/SKILL_SECTION_12d_include_into_branch.md` must be pasted into SKILL.md section 12 (plain
  push, never force, rebase once on a rejected push, report commit/old_head). The old rule
  "never push to any existing branch" stays for the new-branch form.
- 134 backend tests pass. Backend and worker were NOT restarted: validate job on DT-5429 was running.
  Restart both when no job is active.

---

## 2026-11-17 — DT-5319 included; worker wrongly failed a good push (fixed, not committed)
- Include on DT-5319 pushed `bugreg/DT-5319-on-fix-d450-in-build94-test-fixes` (291b52d, base
  `fix/d450-in-build94-test-fixes`, TC_5686 + its main_db row). The skill pushed over SSH because the
  configured HTTPS origin has no credentials in a headless session.
- Bug (mine): the worker's own `git ls-remote origin` check used that HTTPS origin, failed, and marked the
  job failed ("not on origin") although the branch was on GitHub. Fix: `branch_on_origin` also tries the
  SSH form of origin and, when Claude reports a commit, requires the remote branch to be at that commit.
  Checked on the real repo (right sha True, wrong sha False, missing branch False). 131 tests pass.
- Record repaired by re-running verify on the result file and closing the job as done through
  `tc_jobs._close`: job done, Included in runs = the branch. Worker restarted after checking no job ran.
- Not verified: the branch has not been merged or reviewed; Remark stays "candidate, pending review".

---

## 2026-11-17 — Job duration shown on the dashboard (frontend only, not committed, not deployed)
- User could not see how long a validation took. The times were already stored (created/started/finished),
  so only the page changed: panel header shows "took 3 min 7 s" / "running 4 min 12 s" (live, ticks each
  second) / "waiting 20 s"; footer shows start and finish clock times and the queue wait when over 10 s;
  the running chip shows the live time; the finished mark's tooltip says "after 3 min 7 s".
- Checked on recorded jobs: DT-5319 first validate 3 min 7 s, DT-5429 job 8a0a98 19 min 46 s. No backend or
  worker restart needed (job a5cc3a was running).

---

## 2026-11-17 — Validate asks which device: with the fix, without the fix, or both (not committed, not deployed)
- The popup now has "Run on: Device with the fix / Device without the fix / Both" and asks only for the
  chosen devices and their passwords. Device IDs (never passwords) are remembered in the browser; the
  mode starts on the half still missing.
- Backend: `mode` param; password required per chosen device; new outcome `inconclusive` leaves the cell
  unchanged. Worker: `out/<dt>/.dashboard/validation_state.json` records what has been shown for the
  testcases as they are now (fixed pass, unfixed fail), keyed by a hash of the testcase contents, so a
  fixed-only run plus a later unfixed-only run gives Yes and a changed testcase resets both halves.
  Final outcome is never above what Claude found; an unfixed run that PASSES counts as nothing.
- Prompt: Claude reports `fixed_result` / `unfixed_result` (pass|fail|na; unfixed fail is the good case).
  Unfixed-only runs are told not to edit testcases. The real skill has not been run in unfixed-only mode
  yet, and SKILL.md section 12 still describes `device=` as required.
- State backfilled by hand from the recorded Yes runs for DT-5319 (264067316 / 264067451) and DT-5074
  (264067316 / 6603051211). 129 backend tests pass.
- Lesson kept: checked tc_jobs for active jobs before restarting the worker and backend.

- Fix right after: the request model `TcJobRequest` had no `mode` field, so the popup's choice was dropped and
  "Device without the fix" failed with "Device ID must be 6 to 24 letters or digits". Added the field and a
  test that goes through the model; checked against the running backend (no job queued).

---

## 2026-11-17 — Testcase IDs under Generated TCs, click to open the file (not committed, not deployed)
- User generated DT-5074 (TC_5698_CONNECTIONMANAGER_..._UPTIME_IN_CRITICAL_EVENTS.py) and asked for the
  testcase IDs to show below the Generated TCs value, opening the testcase on click.
- Files live on the workstation, so the worker sends them: `POST /tc-worker/files` (hashes first, content
  only where the server's hash differs, files gone from disk are dropped; table `tc_files`, 200 KB cap,
  literal `password = "..."` style values redacted), republished with the requirements (first idle pass,
  after every job, every 5 min). `GET /tc-files/{dt}/{name}` serves one file.
- Page: under a Yes value, one chip per file (`TC_5698`), click opens a viewer with the code and Copy; Esc
  closes. IDs come from the file names on disk, so a rename to the Jira TC id shows up after the next sync.
- 125 backend tests pass; backend and worker restarted; DT-5074 file served (14419 chars).

---

## 2026-11-17 — Open count on Validated + "I accept these open items" before Include (not committed, not deployed)
- Why: DT-5319 showed Validated = Yes while its last run listed 6 open items (krait only, scenarios 02-04
  not run on the unfixed device, unfixed build not checked by binary, 4 untestable paths).
- Cell: amber "N open" chip beside Yes/Partial from the latest finished validate run; grey "N open ·
  accepted" once accepted. Click opens the run.
- Include: backend refuses with 409 while the latest finished validate run has open items nobody
  accepted; the form lists them with a required checkbox and records the actor (table
  `tc_gap_accepted`, keyed by validate job id). A newer validate run needs accepting again; a run with
  nothing open needs nothing. 124 backend tests pass; backend restarted.
- Not done: a manual edit of the cell is not gated; no separate reviewer sign-off field.

---

## 2026-11-17 — Validate popup says which platform and device are needed (not committed, not deployed)
- New `validation_requirements` section in bug_analysis.json (runs_on, na_on, needs, fixed_build,
  unfixed_build, notes); generate and regenerate prompts ask for it. Worker `requirements()` reads it,
  falls back to `family_scope` / `preconditions_for_validation` and turns older free text into notes
  only (nothing invented). Worker publishes per ticket to `POST /tc-worker/requirements` (table
  `tc_requirements`) at the first idle pass, after every job and every 5 min; `/tc-jobs` returns them.
- Popup box "What you need to validate": platform, device with the fix, device without, extras, notes.
- Worker preflight refuses a device whose type is explicitly in `na_on` (it would only report NA).
- DT-5280 shows real platforms; DT-5319 and DT-5429 have only free text, so the popup says "not
  recorded" until they are regenerated or the section is added. 122 backend tests pass.
- DT-5319 showed Validated = Yes with 6 open items: Yes only means pass with the fix and fail without it
  on one krait each; it is not "fully validated". Open question: show the open count on the cell.

---

## 2026-11-17 — Validate corrects the testcase or explains why (not committed, not deployed)
- DT-5319 reached Yes (TC-5686 passed on 264067316, failed at STEP_7 on 264067451 without the fix). The
  user asked who checks testcases with open concerns, then asked for Claude to correct a bad validation or
  give the reason. Built into the validate stage, not a new stage: re-running Validate does it.
- Prompt (worker `build_prompt`): on a failure Claude diagnoses first and names who is at fault
  (`testcase` / `device` / `environment` / `product`). Only `testcase` is fixed, in place, max 3 attempts,
  never by weakening an oracle. Result carries `reason`, `reason_category`, `corrections`.
- Worker: snapshot + backup before validate; `correction_report` reads what changed from the files;
  `revert_edits` undoes unproven edits when the outcome is `no` or the job fails (content only, a rename
  to the Jira TC id is not undone). "Why" goes first in the remaining list.
- Page: Why box, corrections box, and the Validated cell offers "Validate again: Claude corrects the
  testcase or explains" when the value is No or Partial. 119 backend tests pass; worker restarted.
- Not verified with the real skill: no real failing run yet. Not built: reviewer sign-off / "accept these
  gaps" before Include (offered, user has not decided).

---

## 2026-11-17 — "Still to validate" list after a Validate run
- After DT-5319 gave Partial the user asked what is left to validate. The worker now adds `remaining`
  to a validate result: the missing fail-without-the-fix run, generated testcases not in the run, plus
  any lines Claude adds (the prompt asks for them). The job panel shows "Still to validate" or "Nothing
  left to validate". 117 backend tests pass; worker restarted.
- Partial = fixed device only; Yes needs an unfixed device too (rule from the earlier decision).

---

## 2026-11-17 — Enhancements: not_testable outcome, device preflight (not committed, not deployed)

**not_testable:** new generate outcome for permanent verdicts (no lever to trigger the fix; analysis ticket with no fix). Sets Generated TCs to N/A, writes no files; a job that merely `failed` (fix PR not merged, evidence unreachable) still resets the cell so the ticket is run again. The page shows a grey "i" mark for finished-but-nothing-written outcomes (covered, not_testable, not_merged, unchanged). Backend and worker accept it already; the skill must be told: paste `tools/SKILL_SECTION_12c_not_testable.md` into section 12 (replaces the generate outcome bullets). Until then Claude never reports it.
**Device preflight:** before a validate job starts claude, the worker runs the skill's `detect_device.py` (project `.venv`) and an unauthenticated `ssh ... exit` for the device and the optional unfixed device, and fails the job in seconds with a clear reason when the ID is not in ip_db, the type is unknown, the host is unreachable, or the SSH host key changed (names the `ssh-keygen -R <ip>` fix). No Jira ticket is created and claude is not started. A tool that cannot run (no pymongo, no venv) is not treated as a verdict; an unknown (first-seen) host key is left to the run. `TC_WORKER_PREFLIGHT=0` switches it off. It runs when the worker claims the job (seconds after Start), not inside the popup.
**Not changed:** Validate with open fix PRs stays a warning, not a block (a device flashed with the PR branch is a legitimate case).
**Verified:** 116 backend tests pass (5 new); tsc + eslint clean; preflight run live and read-only: 125212600020 ok, 103212503890 ok, 999999999999 rejected as not registered. NOT verified: the host-key-changed path against a real device (unit-tested only), the UI in a browser.
**Lesson (again):** never `pkill -f '<pattern>'` from a Bash tool call here: the pattern is in the call's own command line, so it kills the shell (exit 144) and the rest of the command never runs. Find the pid with `pgrep -f "^python3 tools/tc_worker.py"` (anchored) or `ps`, then `kill <pid>`.

---

## 2026-11-17 — DT-5429 validated on an Octo; worker no longer waits for a claude that will not exit

**DT-5429:** 3 testcases generated (TC_5667 cam_rec restart; the two Octo aux-camera ones became TC-5680/5681). Validated in device = Partial: TC_5667 passed on bagheera3 103212503890 and again on Octo 125212600020; TC_5680/5681 went NA at their capability gate `NO_AUX_CAMERA_ENABLED` (no `chN_enabled` key found on that Octo; the gate heuristic is unverified), so they have not run their steps anywhere. No unfixed device was used (gap).
**Device registry:** ip_db (local mongod) did not know 125212600020; found its UDP broadcast (octo, 172.16.16.41) and inserted it by hand (`deviceID`, `deviceType`, `deviceIP`). SSH user comes from the type (octo -> ubuntu), not stored. Host key at that IP had changed; with the user's confirmation removed the old key (`~/.ssh/known_hosts.old` keeps the old file) and recorded the new one.
**Bug found:** after claude printed its final result the dashboard still said running for ~3 min: claude does not exit while a background shell it started (the skill's `until grep ...; do sleep 5` watcher) is open, and the worker waited for the process. Fix in `tc_worker.py`: once the stream's `result` event is seen, give claude `TC_WORKER_LINGER_SEC` (45 s), then stop it and its descendants (`descendants()` reads `ps`; shells in their own session are found), and log what was stopped. Cancel/timeout deliberately still stop only claude's process group: killing a test run half-way could leave the device configured. Tested with a stand-in claude that hangs (job done in 12 s, no leftover process); 111 backend tests pass.

---

## 2026-11-17 — Regenerate after merge (4th Claude stage), Sonnet for all jobs, DT-5280 generated

**Request:** testcases written while fix PRs are open should be re-checked and updated once the PRs merge.
**Facts found:** `bugreg_research.py` skips the diff of any PR that is not MERGED, so generation from open PRs (DT-5280) relies on Claude reading the PR branch itself. Generate runs so far: DT-5280 ok (3 testcases); DT-3918, DT-3261, DT-5335 honestly refused (no lever / fix not merged / analysis ticket). Worker now passes `--model sonnet` (env `TC_WORKER_MODEL` overrides); the DT-5280 run predates that and used the default model.
**Built:** stage `regenerate` in `tc_jobs.py` (needs Generated TCs = Yes; the cell is NOT set to In progress; outcomes updated / unchanged / not_merged). On `updated`: Validated in device is cleared if it was Yes/Partial/No; Included in runs text is left alone (people type in it) and named in the job message instead. Worker: snapshots the testcase files (sha256) before and after, so updated vs unchanged is decided by the files, not by Claude's claim; backs the files up first and restores them if the job fails, is cancelled or times out; on `updated` moves `device_validation` to `superseded_device_validation` in bug_analysis.json (so the include precheck on disk closes too). Page: "↻ Regenerate after merge" in the Generated TCs dropdown (only when it is Yes); the validate popup warns when a fix PR is still open.
**Skill:** the instructions are in `tools/SKILL_SECTION_12b_regenerate_after_merge.md` (Claude may not edit SKILL.md; the user pastes). The worker fails a regenerate job with a clear message until SKILL.md contains the heading "Regenerate after merge".
**Verified:** 109 backend tests pass (13 new); tsc + eslint clean; end-to-end with a stand-in claude: updated, unchanged, failed-half-way (files restored, stray new file removed), include refused after an update. NOT verified: the real skill's regenerate behaviour, the UI in a browser.
**Open question for the user:** whether Validate should be blocked (or only warned, as now) while a ticket's fix PRs are still open.

---

## 2026-11-14 — Relay Control: restart device always does OFF, 30 min, ON (relayctl.py + Perda wording, not committed)

**Correction (user):** the earlier ping pre-check made `restart device` refuse on a silent bench, but 264067487 was down and the manual OFF, 30 min, ON recovered it. Removed the refusal.
**Now:** `cmd_cycle` always sends OFF, holds ignition OFF for `--min-off-seconds` (1800) in total, sends ON (also on Ctrl-C/SIGTERM), then waits up to `--wait` 600 s for ping. Ping is only logged (went silent after N s), not used to decide. `--down-timeout` is unused. Backup `relayctl.py.bak-before-always-cycle`. Stub-tested for an up and a silent bench with short timings; no real bench run. Perda help/Docs wording updated (needs frontend build + restarts).

---

## 2026-11-14 — Relay Control: restart device keeps ignition OFF 30 min (server relayctl.py + Perda, not committed)

**Request:** user turned bench 264067487 OFF by curl, waited 1800 s, turned ON, and it came back; our `restart device` never did.
**Cause:** `cmd_cycle` treated "ping silent for 60 s" as "powered down" (65 s after OFF) and sent ON 10 s later. The device drops off the network early but its shutdown delay (~15 min per the tool's own help, 30 min worked) keeps running; ON inside that window does not reboot it. The bench was also already dead from ~06:09 IST (cloud keepalive), so earlier tests were confounded.
**Fix:** relayctl.py `cycle`/`restart device`: new `--min-off-seconds` (default 1800 in total since OFF), `--wait` 300 -> 600, SIGTERM now raises KeyboardInterrupt so the `finally` still sends ON (a job timeout cannot leave a bench OFF). Backup `relayctl.py.bak-before-min-off` on the server; live without restart. Perda: restart-device timeout floor 55 min (the UI sent 1800 s, which would have killed the job mid-hold; test added), wording "about 35 min", Docs text. 97 backend tests pass.
**Not verified:** a full real restart (about 35 min on a real bench); the 1800 s value is the user's one successful manual run, not a measured shutdown time. Needs `npm run build` (Node 18) + frontend and backend restart for the wording and floor.

---

## 2026-11-13 — Release Tickets: Claude jobs behind the Team status columns (not committed, not deployed, skill edit pending)

**Request:** Generated TCs / Validated in device / Included in runs should run the bug-regression skill through the claude CLI, each stage only after the previous one is complete.
**Decisions (user):** jobs run on a **workstation worker**, not the DTA server (server has no claude CLI and no bug-regression project); device password is typed in the dashboard popup; fixed device required, unfixed device optional (fixed only = Partial, both = Yes, either unlocks include).
**Built:** `backend/tc_jobs.py` (queue in SQLite tables `tc_jobs`/`tc_workers`, stage gate, one active job per ticket, stale-worker failure after 5 min, writes the result into `ticket_status`), endpoints `/tc-jobs*` (page) and `/tc-worker/*` (worker, `X-Worker-Token` = env `TC_WORKER_TOKEN`; feature is off when unset). `tools/tc_worker.py` (stdlib only): claims a job, runs `claude -p "/bug-regression:bug-regression dashboard-stage=..." --plugin-dir <skill> --output-format stream-json --permission-mode bypassPermissions` in the project folder, streams the log, then checks the result itself (TC files exist, `device_validation` in bug_analysis.json, new branch on origin via `git ls-remote`). `ReleaseTickets.tsx`: "▶ … with Claude" entry in the two dropdowns, ▶ button next to Included in runs, popup forms, live log panel, worker online/offline note. `promote_candidate.py` gained `--test-bot-dir` (deploy into a worktree).
**Passwords:** never in the DB or log; 0600 file under `backend/output/tc_job_secrets/` until the worker claims the job, then deleted; worker passes them to claude as env `BUGREG_DEVICE_PASSWORD` / `BUGREG_UNFIXED_DEVICE_PASSWORD` and scrubs them from log lines. They do cross the LAN over plain HTTP.
**Blocked:** Claude was not permitted to edit SKILL.md (auto-mode classifier: instruction poisoning). The needed "§12 Dashboard-driven stages" section (result file contract, env passwords, the include stage's commit + push of ONE new branch) is in `tools/SKILL_SECTION_12_dashboard_stages.md` for the user to paste in. The worker refuses to start until SKILL.md has that heading. TA_Utility has its own older skill copy; the worker uses perda's copy via `--plugin-dir`.
**Verified:** 96 backend tests pass (new `tests/test_tc_jobs.py`); tsc + eslint clean; full generate → validate → include flow against a local backend with a stand-in `claude` script and a local bare git origin (gates refuse out-of-order stages, password scrubbed, branch created). `--plugin-dir` on the skill folder exposes `/bug-regression:bug-regression` in headless mode (checked). NOT verified: the UI in a browser, and any run with the real claude + real skill + real device.

---

## 2026-11-13 — Build Logs: Octo_Test_Automation_Report builds added, not committed/deployed

**Request:** also log successful builds of Acceptance_Testing_Pipeline/Octo_Test_Automation_Report on the Build Logs page.
**Found:** Octo publishes no `overall_summary.txt`/`parameters.json`; same DAST pages (`linked_issues.html`, `unknown_issue.html`) exist. Per-device table (SKU/OS/OTA/IP/counts) is the `const row = [...]` JSON block in `Test_5freport/static/scr.js`, ~6 MB into an ~84 MB file (before the 78 MB `main_output`). Suffix Range requests are ignored by Jenkins, so the file is streamed and closed once `row` parses (cap 60 MB). Services come from `Setup_NN_Devices/Services` params (enabled setups only). No suite/product params on Octo (left empty).
**Built:** `build_log.py` `JOBS = {daily, octo}`, `fetch_build_record(..., job)`, `read_scrjs_rows`/`parse_scrjs_rows`/`octo_services`; sync result lists are labels (`#85`, `Octo #476`). `build_log` table gains `job` with PRIMARY KEY (job, build_number) (numbers collide across jobs); `_ensure_build_log()` migrates the old table (rows → `daily`) under BEGIN IMMEDIATE. `/build-log?job=daily|octo`. Frontend: Pipeline filter pill, "Octo" tag on rows, keys `job-number`.
**Multi-worker fix:** each of the 4 uvicorn workers starts the poller; sync now takes a file lock (`output/build_log_sync.lock`) and progress is shared via `output/build_log_sync.json`, so only one sync runs (matters now: Octo costs ~6 MB/build).
**Verified:** live fetch of Octo #476 (known 52 + unknown 12 = fail 64, matches report), #300, #100; old #8 has no report → skipped. Real 3-build sync into a DB copy; migration on a copy of local perda.db (220 rows kept). 67 backend tests pass (new `tests/test_build_log.py`); tsc + eslint clean. NOT verified: UI in a browser.
**Deploy note:** first poll after restart backfills all ~326 Octo SUCCESS builds (~2 GB streamed once, a few minutes). Needs backend restart + frontend rebuild.
**Deployed (copied) to server:** `ssh dta_server@172.16.23.15` works with keys (BatchMode). Server main.py differed from local only by my edits. Copied build_log.py, database.py, main.py, tests/test_build_log.py, BuildLog.tsx to `~/perda` (checksums match); backups `*.bak-before-octo` + `perda.db.bak-before-octo`. Importing `main` on the server ran the migration on the live DB (226 rows → daily) before the restart; the old running code cannot save builds until restarted. User builds/restarts. Server venv has no pytest.

---

## 2026-11-11 — Relay Control tab (relayctl.py on the dashboard), not committed

**Goal:** put the daily relayctl commands (bench/relay/Pi check and recovery) into the live dashboard.
**Source:** relayctl.py + COMMANDS.md copy found in an earlier session's scratchpad (TA-Utility project); the DTA server copy was not reachable from here.
**Built:** `backend/relay_ops.py` (whitelisted commands, validated argv, no shell, jobs run detached with log files in `backend/output/relay_jobs/`, one switching job per bench at a time, switching needs `confirmed`), endpoints `/relay/config|jobs|jobs/{id}?after=N|audit` in `main.py`, `frontend/components/RelayControl.tsx` + sidebar entry. Bench lists D215/D450 are constants in `relay_ops.py`.
**Also in Scripts:** `backend/scripts/relay_control.py` (reuses `relay_ops` validation; switching without `confirm_switching` = dry run; relayctl runs detached and is tailed, so a closed page does not stop it). It has no cross-process lock with the Relay Control page; relayctl's own in-use guard still applies. Copied to the server `~/perda` (user restarts services).
**Redesigned twice (user: no scenarios):** final design = a dropdown of the 11 real relayctl commands (`check`, `boards`, `discover`, `status`, `pi-benches`, `pi-check`, `wake`, `restart device|relay|pi`, `recover`), and ALL inputs (Device IDs, Pi name, wait limit, Dry run) always visible, enabled only if the command uses them, marked required/optional/"not used by this command". Single source: `COMMANDS` + `inputs_for()` in `relay_ops.py`; `scripts/relay_control.py` has the same lists as literals (the form reads them without running the file; a test fails on drift). Generic Scripts form gained `choices`, `enabled_when`, `required_when` in `SCRIPT_ARGS` and disables Run until required fields are filled. Switching commands in Scripts default to Dry run ON. Force removed from the UI. relayctl's `ign`, `cycle`, `pi-service`, `pi-reboot` are not in the list (the restart commands cover them). 51 tests pass; deployed to server `~/perda`.
**Bug (user: 'Lost contact with the backend (Unknown job)' on Run):** the live backend runs `--workers 4`; jobs were kept in one worker's memory, polls hit other workers. Fixed: job state is now files (`output/relay_jobs/<id>.json` + `.log`), busy-check under a file lock, dead-process jobs show as `lost`. Verified with 4 real uvicorn workers; 55 tests pass. Lesson: this server is multi-worker, never keep state in process memory.
**Layout simplified again (user screenshot: 'stupid, too much text'):** Relay Control page is now ONE row (command dropdown with plain relayctl names, only the inputs that command needs, Preset D215/D450, Dry run/Run) + full-width output + a one-line Recent strip; no help text, no greyed-out boxes, Rules behind a small link. Screenshot-verified locally against the live backend (headless Chrome via CDP). Live frontend needs `npm run build` with Node 18 (nvm) + restart: `npm run start` serves the old `.next` otherwise.
**`check` now turns relays ON (user: relay was switched off by hand yet `RELAY: OK`):** investigated the Pi relay service read-only: port 8081 only accepts set commands (`id=<board>&<ch>=on|off`), FTDI bit-bang driver, no way to read a channel's state without changing the service. Decision (user): no state read; `check` switches each healthy bench's relay ON and prints `RELAY: ON`. Edited the SERVER's `~/shankar/relay_recovery/relayctl.py` (backup `relayctl.py.bak-before-check-on`): after verdicts, sequentially (service not thread-safe) `relay_call(..., 'on')` only for benches whose relay layer was `OK` (real board id, channel known); results `ON` / `? (ON sent, not confirmed)` / `BAD (...)`; `--dry-run` switches nothing. Dashboard: `check` refused (409) while a restart/recover holds the same bench (would turn its relay ON mid-restart); `check` does NOT use relayctl's in-use guard because ON is the normal state during runs. Tested with stubbed hardware only (ON, unconfirmed, failed, wrong board, no channel, dry-run); a real run is not done by me. 56 tests pass.
**Scripts list cleanup (user request):** deleted `scripts/relay_control.py` (the sidebar Relay Control page is the only way to run relayctl now; `choices/enabled_when/required_when` support in the generic form stays, unused). `rc_comparison`, `daily_comparison`, `logs_download` are HIDDEN from `/scripts` via `HIDDEN_FROM_LIST` in `script_runner.py`, NOT deleted: the backend imports `rc_comparison` (Test Report, TC Confidence/Analysis, build cache) and runs `logs_download` (Device Logs). Side effect: they also vanish from the Workflow Builder palette (it uses `/scripts`); saved workflows can still run them by name. Scripts list now: broadcast_check, delete_shadow, keepalive_check. Backend restart needed.
**Docs button (user request):** bottom of the Relay Control page, `Docs` toggles an inline guide (`RelayDocs` + `DOC_TEXT` in `RelayControl.tsx`, frontend-only text): wiring chain, quick start, every command (what / input / when, 'switches hardware' tag), how to read `check` (DEVICE / RELAY / PI good vs problem), which command for which problem, rules. Command groups now ordered by workflow (`GROUP_ORDER`). Rules text no longer mentions Force. Screenshot-verified locally. Needs frontend rebuild + backend restart (rules text).
**Fixes after first real `check` runs (user screenshot):** (1) DEVICE showed BAD after ~3 s of missed pings (`ping -c 3`); now relayctl `verdicts()` retries for `DEVICE_WAIT`=10 s (ping, then SSH port) and only then says `BAD (no ping for 10s)`; a bench that answers returns OK at once; a down bench makes the whole check take about 10 s (benches checked in parallel). Pi layer unchanged (8 pings, ~1.6 s). Server backups: `relayctl.py.bak-before-check-on`, `relayctl.py.bak-before-10s-wait`. (2) Audit log could not be closed: button now toggles (`Hide audit log`). (3) A check/boards run with BAD found exits 1 and showed `failed (exit 1)`; now `finished: BAD found`. Real first run result: 8 benches, relays reported ON. Frontend rebuild needed for (2),(3); (1) is live now.
**`restart device` false 'went down' (user: two restarts, 'off by 65 s', device never came back, suspects it never turned off):** log proves the relay DID switch OFF (`confirmed OFF`), but `cmd_cycle` never checked the bench was UP first; 'went_down after 65s' is the minimum the loop can print (5 s poll + 60 s `confirm_seconds`), so an already-silent bench is reported as 'went down'. Evidence: 264067487 last heard in topology 2026-11-13 15:01, no ping now; 264130601 (11-12) identical 65 s / 303 s; OFF pulse only ~76 s. Fix in server relayctl.py (backup `relayctl.py.bak-before-restart-precheck`): step [1] pings for up to 10 s before switching; if silent, refuses, switches NOTHING, suggests wake/recover. Tested with stubbed hardware (silent / up and returns / never goes silent). NOT done: a real restart on a live bench; also unresolved: whether a live device really drops ping within seconds of ignition OFF (docs say 17-20 min shutdown delay) and whether 300 s `--wait` is enough for boot. Docs text + backend help updated (frontend rebuild + backend restart).
**Why detached + polling (not SSE):** `restart device` takes 17-20 min; closing the tab must not kill it mid-ignition-off.
**Verified:** 46 backend tests pass (`test_relay_ops.py` uses a stub relayctl); tsc + eslint clean; API smoke test with stub. NOT verified: the UI in a browser, and real relayctl on the server.
**Deploy needs:** backend on the server with `~/shankar/relay_recovery/relayctl.py` readable by the service user (or `RELAYCTL_DIR`); restart perda-backend and rebuild the frontend.

---

## 2026-11-11 — Redesign reverted to the original

**Request:** user asked to revert everything and restore the original dashboard.
**Done:** `git checkout -- frontend`, removed `.hallmark/`, `frontend/.hallmark/`, `tokens.css`, `Dash.tsx` and the new fonts. Frontend now matches commit d40d7bf. Backend was never touched.
**Kept:** CLAUDE.md, SESSION_LOG.md, get_base_ota.py (not part of the redesign).
**Backup:** the redesign can be restored from `redesign.patch` + `untracked.tgz` in the session scratchpad (`.../scratchpad/redesign-backup/`); may be cleaned up with the session.
**Note:** the entries below describe the reverted redesign; they are history only. The 4.9 s vs 39.4 s broadcast difference was the local backend's Wi-Fi, not the UI.

---

## 2026-11-06 — Dashboard redesign with the Hallmark skill, local only (Blueprint rejected → Console + new layout, then toned down)

**Goal:** make the dashboard cool, modern, high-tech and friendly; review on localhost before anything goes to the DTA server.
**Corrections made:** first pass used the *Blueprint* theme (square blue drafting sheet). User: "the team mostly won't like this",
wants the layout redesigned too, classy/high-tech, "must feel like a crazy website". → switched to **Console** (graphite dark /
paper light, Host Grotesk + Atkinson Hyperlegible Mono, amber = primary action, cool blue = selection/data) and pushed it
past the theme's "nothing glows" because the user asked for wow (recorded in the CSS stamp).
**Later corrections:** I added an Overview home page and heavy effects (glow, spotlight, orbiting border, sheen, status bar).
User: "I don't want the overview page and feel the dashboard is overdone." → Overview deleted (default page is Scripts again) and all
effects removed. What remains is the calm version: flat graphite/paper panels with hairlines, one amber primary button, cool-blue selection.
The effect-heavy bullets below describe the *intermediate* state; ignore them. Lesson: keep it restrained, add no new pages unasked.
**Layout pass (user: "I wanted you to redesign the layout totally"; do Scripts first, then Test Report, then show):**
- `components/ScriptRunner.tsx`: two-pane workbench. Left: script title + first docstring line (rest under "How it works"), fields,
  list-type args (`*_list`, `*_ids`, "comma separated") become textareas with a live entry count, required-field hint, sticky Run bar,
  Ctrl+Enter. `delete*` scripts ask for confirmation before running. Right: full-height terminal with line numbers, status badge,
  ok/failed counters parsed from the printed ✅/❌ lines, Copy, Clear, output-file download buttons. Run/stream logic untouched.
- `components/TestReportDashboard.tsx`: after a report loads, the input card folds into a one-line compare bar (Change builds,
  Re-fetch, Download Excel); sections become sticky tabs (Regressions, Persistent failures, Fixed, Stable, Build overview, Services)
  with counts; the verdict strip stays on top. All drill-downs and data code reused unchanged.
- NOT verified: a live script run and the delete confirmation step (the automation was blocked from running scripts, correctly).
  User should try broadcast_check with a short timeout on localhost.
**Terminal pane (user: "doesn't give actual terminal vibes"):** `ScriptRunner.tsx` Output → Terminal. Shell prompt line with the
command being run (`$ python3 broadcast_check.py --device_list … --timeout 120`, display only), blinking block cursor, Geist Mono,
always-dark terminal in both themes (`--term-*` tokens), no line-number gutter, ANSI colour codes rendered, final
`[process exited with code N after S s]` line + fresh prompt, auto-follow that pauses when you scroll up with a "Jump to latest" button.
Only the idle state was screenshotted; the running/finished states and ANSI output are untested (scripts must be run by the user).
**Speed report (live 4.9 s vs local 39.4 s for the same broadcast_check):** not a frontend issue; the script runs on whichever machine hosts
the backend and listens for UDP broadcasts on port 12345. Local backend runs on the laptop's Wi-Fi (172.16.17.157), live one on the
wired server (172.16.23.15); Wi-Fi delays/drops broadcast frames, so the last device is heard later. To confirm: run the local UI against
the live backend (`NEXT_PUBLIC_API_URL=http://172.16.23.15:8000`). Separate fix made: list args are normalised to commas before sending
(scripts split on commas only, the new textarea allowed newlines).
**Terminal correction (user: did NOT want commands shown, meant colours and the way output arrives):** removed the `$ command` prompt,
"waiting" comment and exit line. Terminal is now plain: neutral black (`--term-bg` 13%), grey-white text, stdout and stderr the same
colour like a real terminal, colour only from ANSI codes the script prints, white blinking block cursor while running/idle, tighter
13px/1.4 spacing, `\r` (progress lines) keeps only the last segment. Backend already streams line by line with `python -u`, unchanged.
Still unverified live: running output (scripts can't be run by the assistant).
**Bug fixed (user: pasted into broadcast script after switching tabs, Run stayed disabled):** returning to Scripts reset the form
(device list and timeout came back empty; in dev, React StrictMode ran the restore effect twice and wiped values). The per-script
cache was a ref inside `ScriptRunner`, lost on unmount. Now a module-level `SCRIPT_CACHE` with write-through saving, so forms,
terminal output and exit status survive tab and script switches. Also: required args with a default no longer block Run, and empty
args fall back to the default. Verified with a puppeteer tab round-trip (view-only).
**Colour softening (user: colours too sharp, uncomfortable):** ground lifted from near-black to a blue-grey (oklch 21%), text off-white
(92%) instead of near-white, amber primary muted to a soft gold (chroma .15 → .09), cool blue desaturated, status palettes
(emerald/green/red/rose/amber/yellow/orange/sky/cyan/teal/blue) re-generated in `tailwind.config.ts` with ~half the chroma; light
theme ink is a soft navy-grey, not near-black. Tune in `app/tokens.css` (`--sheet*`, `--color-*`) and the `soft()` chroma scale.
**Built / changed (frontend only, nothing committed or pushed):**
- Installed skill: `npx skills add nutlope/hallmark -g`.
- New shell in `frontend/app/page.tsx`: CSS-grid app shell = glass top bar (brand, big command bar, backend chip, theme toggle),
  navigation rail grouped Run / Analyse / Review and release / Automate (collapsible to icons), page header with breadcrumb + title +
  description, and a status bar (backend state, host, scripts loaded, shortcut hints, version). Palette/shortcuts/handlers unchanged.
- (REMOVED later) Look: ambient drifting glow + dot grid behind the stage, cursor-following spotlight and lit border on every `.ds-card`
  (one pointermove listener in page.tsx), orbiting gradient edge on the command bar, glowing active-nav bar, amber primary buttons
  with a sheen, pulsing live-status dot. All motion honours prefers-reduced-motion.
- Tokens `frontend/app/tokens.css`; Tailwind `gray` and `indigo/violet/purple` ramps read CSS variables (one switch for dark/light);
  `globals.css` rewritten (class names kept); fonts self-hosted in `frontend/app/fonts/`. `components/Dash.tsx` = "no value" marker.
- Earlier lint clean-ups kept: aria-hidden SVGs, no `transition-all`, no tracked caps, no emoji icons, no em dashes / middle dots in UI copy.
- Skip-to-content link added.
**Verified:** `tsc --noEmit` clean; sloplint `--scope app --render`: remaining items are WARNs (default-palette notes, long labels);
screenshots of all pages in dark and light with real data (Test Report 1189→1204), command palette, collapsed rail.
**Gotchas / open items:**
- Review locally: `cd frontend && NEXT_PUBLIC_API_URL=http://localhost:8000 npx next dev -p 3100` + `backend/venv/bin/uvicorn main:app --port 8000`.
- ReviewBench height is `calc(100vh - 16rem)` to fit under the taller page header; check it on the team's screens.
- Page titles are solid ink (a gradient title failed contrast).
- Not yet eyeballed with real data: TC Analysis logs, Review Bench rows, Workflow canvas nodes, Release Tickets with a release loaded.
- Untracked `.hallmark/` folders are skill artefacts; don't commit.

---

## 2026-11-05 (later) — Release Notes Sync: revisions after first live test

**User feedback → changes:**
1. Project / Release / RC are now dropdowns fed by the release-notes app (`GET /release-sync/releases`,
   cascading; RCs newest first, special packages `*.sp.*` in their own group). Replaces free-text boxes.
2. Per-device result redesigned to match Test Report Summary: reuses `VerdictStrip` (now exported from
   TestReportDashboard.tsx), stat tiles, regressions table with All/Known/Unknown filter + "show more".
   Fixed table overflow with `table-fixed` + colgroup.
3. Change log is **nd_test_bot only** (`CHANGELOG_REPO`, default `nd_test_bot`): base/head branch inputs with a
   branch datalist (`GET /release-sync/branches`). Removed the 7-repo tag logic and `/release-sync/refs`.
**Verified:** 26 backend tests pass; UI driven in headless Chrome (dropdown cascade, filters, overflow = 0px).
**GitHub token saga:** old token was dead (401); 2nd was valid but the `netradyne` org forbids classic PATs with
lifetime >90 days; 3rd was mistyped (401); 4th works (read on netradyne/nd_test_bot). Stored in backend/.env
(gitignored → the server's .env needs it too). Org policy: tokens must expire within 90 days → renew then.
**After token fix, verified live:** nd_test_bot has 1,224 branches (MAX_BRANCHES raised to 5000, list cached 5 min,
~8 s cold); real compares work (`6.16_fixes...6.17_mainline_fixes` = 420 commits, paged, Jira keys picked up,
truncated at 20,000 chars with a "+N more, see <compare url>" note; `master...DTA_6.17_unified` = 1,666 commits, ~30 s).
Truncation keeps the oldest commits and drops the newest. 27 tests pass.
**Open:** revisions not yet committed/pushed. User pasted tokens in chat → should revoke those.

---

## 2026-11-05 — Built: "Release Notes Sync" tab (dashboard side only, no push)

**Decisions from user:** payload = overview + comparison counts + **regressions only** (no persistent/fixed/
new/removed lists); release notes adds no tab — data goes into the existing Reports section; device map
D450=B3, D215=K2, D430=B2, D210=K1 (US/IN/UK), D810=Octo; change log from GitHub between two branches/tags.
Auth + the actual push are **deferred** until after dashboard testing and talking to the owners.
**Built:** [backend/release_sync.py](backend/release_sync.py) (payload shaping, GitHub compare → change-log text capped
at 20,000 chars, default refs from release-notes RC details, dry-run request builder);
endpoints in `backend/main.py`: `GET /release-sync/devices|refs`, `POST /release-sync/summary|changelog|dry-run`;
[frontend/components/ReleaseSync.tsx](frontend/components/ReleaseSync.tsx) + sidebar entry in `app/page.tsx`.
Tests: `backend/tests/test_release_sync.py` (23 tests total pass: `cd backend && venv/bin/python -m pytest tests`).
**Verified:** real cached builds 1189→1204 as D210_US gave 47 regressions (21 known/26 unknown); UI driven in
headless Chrome (throwaway servers on 8100/3100). Push button is intentionally disabled.
**Open / gotchas:**
- `GITHUB_TOKEN` in backend/.env returns 401 "Bad credentials" → change log could not be tested live (stubbed in tests). Refresh it.
- Release notes only has tags for rc.1; rc.2 head tags are blank until they fill them (UI lets you type them).
- Octo (D810_US) has no dashboard platform yet → disabled in the device list.
- `linked_issue` carries Jira's status text, e.g. "ITN-2951 (To Do)".
- Push not built: need auth, and release notes must accept/render `testAutomationSummary` (the PATCH
  currently only knows testAutomationReports + testAutomationChangeLog). Backend on :8000 needs a restart to pick up new endpoints.
- Pre-existing lint errors in app/page.tsx (addToast, activePage unused) — not from this work.

---

## 2026-11-05 — Investigation: push Test Report Summary into Release Notes dashboard

**Goal:** Validate idea of a new dashboard tab with an "Update" button that sends the Test Report
Summary comparison to the release-notes app (`:5050/release-notes/...?tab=reports`).
**Findings (read-only, nothing written to the release-notes app):**
- Our data: `POST /test-report-summary` in `backend/main.py` (~L712-1287) already returns everything
  (overview, rc1_overview, regressions, persistent_failures, fixed_tcs, new/removed_tcs, ...).
- Release-notes app is Next.js. Reports tab saves via
  `PATCH /release-notes/api/releases/{edition}/{rcVersion}/open-sections?project=DT` with
  `{testAutomationReports: {<device>: {regressionBugfixLink, installerAppLink, dhubLink, vdmLink}},
  testAutomationChangeLog: <plain text, max 20000 chars, one for all devices>}`.
  UI sends the whole `testAutomationReports` object → must read-modify-write to avoid wiping others.
- Device names there are D450_US/D215_US/D430_US/D210_UK/D810_US; ours are K1_US/B3_US/... → need a mapping.
- Not verified: PATCH auth (UI gates on admin; unauth GET works), device-code mapping.
**Proposal given to user:** phase 1 = link + text summary via existing endpoint; phase 2 = new structured
`testAutomationSummary` field owned by release-notes team.

---

## 2026-11-04 / 05 — Base OTA fetch script (`get_base_ota.py`)

**Goal:** Automate getting the *current base OTA* version per product from IDMS (staging)
instead of looking it up manually. Started from `get_latest_base_ota()` in
`netradyne/device-build`, branch `dyn_octo_upload_fixes_BMP`,
`automation_scripts/upload/get_product_category.py`.

**Built:** [get_base_ota.py](get_base_ota.py) — standalone, stdlib only (urllib, no curl/requests).
- `python3 get_base_ota.py <product>` — e.g. `octo`, `krait2_global` (aliases like `bagheera3_in` work)
- `python3 get_base_ota.py --device-id <id>` — resolve product from a device first
- `python3 get_base_ota.py --all` — only the 8 required products:
  krait, bagheera2, krait2, krait_global, krait2_global, bagheera3, bagheera3_global, octo
- Env overrides: `IDMS_AUTH_URL`, `IDMS_URL`, `IDMS_USER`, `IDMS_PASSWORD`
  (defaults = staging + the `device-test-automation` account from the original script).
- Retries dropped connections; re-logs in on 401.

**Final logic (what "current base OTA" means):**
Source: `GET {IDMS_URL}/console/version-check/getAllVersions` → `data.versions`.
Keep records where `productId` matches AND `status == 1` (Active) AND `productionReady` is true
AND `stages_enabled` is false (i.e. console Actions column shows only **Edit**, no **Stages**).
Pick the highest `ID`; return its `C_P_Version`.

**Corrections made (in order) — don't repeat these mistakes:**
1. First version copied the original: latest *special package* (`/admin/specialpackages`) by
   `created`, return `baseVersion`. **Wrong** — mentor flagged it. Special packages are built on
   mixed bases (rc.5/rc.6/rc.7 interleaved), so newest-created ≠ current base.
2. Switched to the console's regular OTA package list, filtered Active + production ready.
3. Then excluded packages that are in stages (`stages_enabled`), per user: only "Edit" packages.
4. `--all` limited to the 8 required products; single-product lookup left unrestricted.

**Result (2026-11-05, staging, `--all`):**
krait 2.6.16.rc.6 · bagheera2 3.6.16.rc.6 · krait2 4.6.16.rc.6 ·
krait_global 2.6.16.rc.6.global.rc.1 · krait2_global 4.6.16.rc.6.IN.rc.1 ·
bagheera3 5.6.16.rc.6 · bagheera3_global 5.6.16.rc.6.IN.rc.1 · octo 7.6.16.rc.7.
`octo_global` has no qualifying package (script exits with an error for it).

**Gotchas / notes:**
- Staging endpoints are slow-ish (list calls ~20 s; the old specialpackages call was 45 s–2.5 min).
- The console may also gate the Stages button on a permission, soft-OTA-rollout flag, and cluster;
  the script only uses `stages_enabled`. If the console shows an Edit-only package the script
  excludes, investigate.
- Not re-tested after the rewrite: `--device-id` path.
- The console app bundle (https://cdn-staging.netradyne.com/console/js/…app.full.min.js) is the
  best place to discover IDMS endpoints/field names (e.g. grep `getAllVersions`, `stages_enabled`).
- Repo clones with the `dyn_octo_upload_fixes_BMP` blob locally:
  `~/Documents/AOR_utility/repos/device-build` (others are partial clones; SSH key can't fetch).

---

## Entry template

```
## YYYY-MM-DD — <short title>
**Goal:**
**Built / changed:** (files, commands)
**Result:**
**Corrections made:** (what was wrong → what fixed it)
**Gotchas / open items:**

```
