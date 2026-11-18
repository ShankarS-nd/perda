# Session Learnings & Tactics

**Purpose:** this document is for a *future session with no memory of this one*. It captures
hard-won, non-obvious knowledge — mostly things discovered by reading actual source code or by
running candidates on real hardware, not things that could be re-derived by reading the other
two docs alone. Read `docs/BUG_REGRESSION_ARCHITECTURE.md` (what the framework is) and
`docs/HOW_THE_TOOL_WORKS.md` (how the pilot pipeline works) first — this document assumes both.

**How to use this doc:** don't read it front-to-back before acting. Skim the headers, find the
section relevant to what you're about to do, read that section, then act. Section 3 and 6 are the
ones most likely to save you from repeating an expensive mistake.

---

## 1. Where things live

| What | Where |
|---|---|
| Research/validation scripts | `out/bugreg_research.py`, `out/validate_candidate.py` |
| Per-ticket artifacts | `out/<TICKET>/` (`research_bundle.json`, `bug_analysis.json`, `coverage_mapping.json`, the generated `.py`, `execution_<n>_failure_analysis.json` if run) |
| Cross-ticket cache | `out/_cache/{jira,manifest,registry}/` |
| Local Python env for running the framework | `.venv/` at the workspace root (created because `numpy==1.24.4` in `requirements.txt` has no Python 3.12 wheel — see §8) |
| Target framework repo | `repos/nd_test_bot`, branch `origin/BI_6.16_20251108` pinned throughout this session |
| Remote/shared execution host | `dta_server@172.16.23.15` (see §7) — the personal-ish checkout used there is `/home/dta_server/shankar/nd_test_bot` |
| Tickets worked this session | DT-3948 (WIFI, `TC_4127`), DT-4290 (APM, `TC_3891`), DT-3961 (SPEED, `TC_3961`) |
| Device used for all real-hardware validation | `264065431`, krait/dvt2, IP `172.16.18.69`. **Password rotates — always ask the user for the current one, never assume a password from a past session is still valid.** |

---

## 2. The pipeline, in one paragraph

`bugreg_research.py TICKET --branch X` gathers deterministic evidence (Jira fields, git-located
fix commit, candidate oracle log lines, DSL manifest, `main_db.xlsx` registry, component guess)
into `research_bundle.json`. The AI (you) reads that bundle, writes `bug_analysis.json`,
`coverage_mapping.json`, and the candidate test `.py`. `validate_candidate.py` checks the test
against 3 gates (structure / vocabulary / import) — **passing only means "not obviously broken,"
never "correct."** Real correctness has only ever been established by running on hardware. See
`docs/HOW_THE_TOOL_WORKS.md` for the full walkthrough.

---

## 3. Hard-won framework facts (learned by reading source, not by assumption)

These cost real device time and/or a real incident to discover. Read this before writing or
running any test that touches config files, reboots, or service state.

### 3.1 `UpdateConfig_obj.download_config()` (`Lib/apis/Config_api.py:128`)
- If its own `file_availability()` check says the file is **not present**, it silently pushes
  `bin/default_bagheera_override.ini` (a generic template, not the device's real config) **and
  reboots the device**, before doing anything else.
- **This file-availability check is flaky, not just occasionally wrong on old builds** — it
  returned a false negative on one run and a correct positive on the very next run against the
  identical live file, no changes in between. Never trust a single "file not present" result;
  if this matters, verify independently via a direct read-only SSH check.
- A test that merely calls `download_config()` in a precondition can therefore trigger an
  unplanned reboot. This was never anticipated when `TC_3891`/`TC_4127` were first written —
  only checking the method's *signature* against the manifest gives zero warning of this.
  **Lesson: before trusting any state-mutating method in a generated test, read its body, not
  just its signature.**

### 3.2 `UpdateConfig_obj.upload_config()` (`Lib/apis/Config_api.py:410`)
- Before pushing new content, it does `mv {remote_file} {remote_file}_org` as a backup — **with
  no exit-status check on that `mv`.** A silent failure here looks identical to success in the
  logs.
- It also calls `_sync_md5_backup()` (see 3.4) on the **new, modified** content immediately
  after pushing it — this has a real, separate consequence, not just a logging side-effect.

### 3.3 `UpdateConfig_obj.reupload_config()` (`Lib/apis/Config_api.py:547`)
- Looks for `{remote_file}_org`; if found, `mv`s it back and reports
  `"Config File Reuploaded Successfully"` / `"Original ... restored on device"`.
- **This "success" message does not prove the restore actually changed anything.** Confirmed
  twice: once where `_org` reported "not present" (framework's own flakiness, §3.1's class of
  bug), and once where `_org` *was* found and moved back — but its content was already the
  dirty, modified version, because of §3.4's mechanism. In that second case the log said
  "Original ... restored" while the live file still had the test's injected change.
  **Lesson: after any test that runs `reupload_config()`, independently verify the actual live
  file content and its md5 against the backup directory. Never trust the log line alone.**
- If `_org` is genuinely absent, it falls back to pushing the same generic default template
  **and reboots again**, then still reports the step as `Fail`.

### 3.4 The SVC `config_recovery` self-healing mechanism (this is the one that matters most)
- The device runs a background service (`[svc] config_recovery_enable = true`,
  `config_recovery_poll = 900` — polls every **15 minutes**) that compares the live config's md5
  against a reference copy at `/home/ubuntu/backup/md5/<filename>.<md5hash>` and **silently
  restores from that reference if they don't match.**
- `_sync_md5_backup()` (`Config_api.py:57`) is what updates that reference. It's called by
  `upload_config()` right after pushing *modified* content — meaning **the device's own
  self-healing mechanism is told the test's temporary modification is now the "correct,
  canonical" state.**
- **Consequence:** manually fixing a live config file with a direct `sed`/edit over SSH is
  *not durable* on its own. If you don't also refresh the md5 backup to match, SVC will quietly
  undo your fix within 15 minutes — not because of anything else running, just the device
  correcting itself back to what it was told is right. This happened for real in this session:
  a manual content-only fix was silently reverted, and it looked like a mystery re-corruption
  until the md5 backup directory was checked directly.
- **The correct, durable fix pattern** (used successfully twice this session):
  ```bash
  # 1. Fix the live file content
  sed -i '<line>d' /data/nd_files/config/bagheera_override.ini
  # 2. Refresh the SVC md5 backup to match -- mirrors _sync_md5_backup()'s own commands
  rm -f /home/ubuntu/backup/md5/bagheera_override.ini.* /home/ubuntu/backup/md5/bagheera_override.ini_org*
  md5_val=$(md5sum /data/nd_files/config/bagheera_override.ini | awk '{print $1}')
  cp /data/nd_files/config/bagheera_override.ini /home/ubuntu/backup/md5/bagheera_override.ini.$md5_val
  # 3. Restart whatever service reads this config
  systemctl restart apm   # or wifi_mgr, etc.
  ```
  Verify by confirming `md5sum <file>` exactly matches the single backup filename left in that
  directory (there should be exactly one, matching the current content — if there's a stale one
  alongside, `config_recovery` may still misbehave).

### 3.5 `Lib/Connectivity/ssh.py:get_file()` (line ~111)
- After `scp` returns exit code 0, the *only* verification is `ls {local_file_path} | wc -l` —
  does *a* file exist at the destination. **It never checks that the download actually
  overwrote it with fresh content.** If `scp` silently no-ops, a stale local file from a
  *previous test run* gets reported as `"File downloaded successfully"` and gets used as if
  fresh.
- This is the same anti-pattern as §3.2 and §3.3: verify that an operation *ran*, not that it
  produced the *intended result*. All three live in the config-management code path and compound
  each other.
- **Practical consequence:** if a test's "downloaded" local config looks suspicious, check its
  actual mtime/content, and if in doubt, delete the local cache
  (`Test_Automation_Framework/Output/Config_File/<device_id>/<file>`) before re-running so the
  next download can't silently reuse stale data.

### 3.6 Service names vs. log-folder names are not interchangeable
- `LogAnalyzer_obj.search_logs(service_name, ...)` takes a **log folder name**
  (`/home/ubuntu/.nddevice/log/<name>/`).
- `ServiceController_obj.service_status([...])` takes a **systemd unit name**.
- These are usually — but not always — the same string. Confirmed counter-example: `"ndcentral"`
  is a valid, correct `search_logs` argument (that's genuinely where `bagheera`'s central-logging
  output lives), but there is **no `ndcentral.service`** — the real systemd unit is `bagheera`.
  A generated test that reused `"ndcentral"` for `service_status` passed all 3 static gates
  (it's a syntactically valid string argument) and failed only on real hardware.
- **Before writing `service_status([...])` for any service, verify the real unit name** via
  `systemctl list-units --type=service` on the actual device, don't infer it from the log-folder
  convention or from the bug's own vocabulary.

### 3.7 `Interface/report_generation.py` and its Flask subprocess
- `flask_exec()` (`Interface/flask_executor.py`) launches `report_generation.py` as a **separate
  subprocess** via `subprocess.Popen`, reading `Output_Collec` / `Input_Test_Collec` from its own
  environment or from `--output_collec`/`--input_collec` CLI args (`report_generation.py` argparse,
  ~line 671).
- The app registers **its own SIGHUP handler** (`register_sighup_signal_handler`). This means
  plain `nohup` is **not sufficient** to keep it alive after an SSH session closes — nohup's
  SIG_IGN gets overridden by the app's own handler, and the process dies when the session hangs
  up regardless. **Use `setsid` for true session detachment**, not just `nohup`:
  ```bash
  cd <workspace>/Test_Automation_Framework/src
  setsid nohup python3 ../Interface/report_generation.py --run_from_framework True \
      --port <N> --output_collec '<name>' --input_collec '<name>' < /dev/null \
      > logfile 2>&1 &
  disown
  ```
- Both `--output_collec` **and** `--input_collec` must be set, or `get_test_count()` crashes with
  `TypeError: name must be an instance of str` inside a broad `except Exception: return
  render_template('empty_template.html')` — which silently renders a "Please Wait, files are
  being created" page instead of a real error. **If a report page is stuck on "Please Wait,"
  check the process's own log for a traceback before assuming it's just slow** — that page
  renders both for "genuinely still populating" and for "silently caught exception."
- First requests through this Flask app can take **15–50 seconds** before responding (it routes
  Mongo access through a gRPC wrapper that retries before falling back to a direct connection) —
  this is expected, not a hang. Use a `curl --max-time 60`+ style check, not a 5-second one,
  before concluding a report server is broken.

### 3.8 `Lib/apis/dictionary_api.py` — DSL interpreter mechanics worth knowing exactly
- **Sub-step naming** (`STEP_4_1`, `STEP_4_2`, etc.) is a real, precedented convention (used in
  the existing `TC_2941`). `out/validate_candidate.py`'s Gate 1 originally rejected this — fixed
  to allow `STEP_\d+(_\d+)?`. If you see this rejected again, the validator regressed, not the
  test.
- `"action": "continue to <StepName>"` is a real jump mechanism (`action.split(" ")[-1]` as the
  target). **Jumping directly to a step named `PostCondition_X` does not execute it via the main
  loop** — the main loop explicitly skips over anything starting with `PostCondition` (to avoid
  double-execution). This is fine and intentional: `Workflow._execute_postconditions()`
  (`dictionary_api.py:805`) is a **separate, dedicated pass** that runs after the main loop ends,
  regardless of how the loop got there (natural fall-through or an explicit jump). So
  `"continue to PostCondition_1"` **does** result in cleanup running correctly — confirmed by
  reading the full mechanism, not by assumption, after nearly assuming the opposite.
- `"force_to": "NA"` in a `validate_data` branch immediately raises `Exception("Force to NA")`,
  which is caught by a handler that sets the step status and returns **without calling
  `_execute_postconditions()`** — unlike the `force_to: "Pass"`/`"Fail"` paths, which do call it.
  **This is a real bug in the framework: `force_to: "NA"` skips cleanup.** Avoid it for any test
  that has meaningful postconditions; use an explicit `"continue to PostCondition_X"` jump
  instead (see above) if you need to skip ahead while still guaranteeing cleanup runs.
- Component object construction (`Step.__init__`) instantiates **all 28 DSL objects on every
  single step**, regardless of what that step actually calls. This is why a missing dependency
  for an *unrelated* object (e.g. `psycopg2` for `ParseObservation_obj`, needed by nobody in a
  given test) can crash a test that never uses it. A `--help`-only dry run of `main.py` does
  **not** exercise this path — only actually constructing a `Step` does. See §8 for the full
  check that does exercise it safely.

### 3.9 `main_db.xlsx` field conventions — verified against real data, not assumed
Sampled ~400 real rows before trusting any convention:
| Column | Real convention | What NOT to do |
|---|---|---|
| `retry` | blank/`None` in 399/399 sampled rows | Do not write `"No"` — breaks a downstream `int(retry)` call in at least one code path, causing a real (non-device-affecting but confusing) crash |
| `isChildCase` | blank/`None` in 383/399 rows (`=TRUE()`/`"Yes"` for the rest) | Don't default to `"No"` |
| `Stable` / `<version>_Stable` | real `"Yes"`/`"No"` strings, both genuinely used | Fine to write `"No"` for an unreviewed candidate — but see next row |
| `Stable`/`6.16_Stable` and CLI runnability | **Not read at all** by the direct `-t TC_id` execution path — confirmed by reading `extraction_from_maindb.py:read_from_excel_file()`, which only reads columns 0–4. A candidate ran fine with both set to `"No"`. | Don't assume these gate runnability for direct single-ID runs; they may matter for other selection modes (`-t SERVICE`, `-t all`) not tested this session |
| `Remark` | free text | Use this to mark `"candidate, pending review"` — keeps `Stable=No` honest without needing it to also encode "not yet approved" |

### 3.10 The framework already has its own Jira integration
`jira_info.py` (called from `report_generation.py`) resolves a test's numeric filename ID as a
Jira `TC-<n>` reference and looks up its status — this directly contradicts the original Phase 1
architecture finding ("no Jira integration exists"). It was discovered mid-session via a
`linked_issues_status` field appearing in real `status_document` output. One observed anomaly:
for `TC_3961` it resolved to `TC-3958` (wrong ticket) while for `TC_4127` it resolved correctly to
`DT-3948`. Cause not yet investigated — worth checking `jira_info.py` before building any
Jira-lookup logic into the pilot tool, to avoid duplicating (or conflicting with) this.

### 3.11 `gpio_test -o 0`/`-o 1` pairs are level signals (assert/de-assert), not pulses —
always check for the release command before treating a GPIO fault-injection as complete
Confirmed by reading `nd_core_utils/cpp/src/nd_device_bag3.cpp:72-73,241-242,271-272`: the device's
own source names these exact pairs `left/right_cam_reset_cmd` (`-o 0`, assert reset) vs.
`left/right_cam_oo_reset_cmd` (`-o 1`, "oo" = "out of" reset), used together in
`reset_left_cam()`/`reset_right_cam()` (assert, sleep `BAGX_CAMERA_RESET_DURATION` 100ms,
de-assert). Real example this surfaced from (DT-4501): `TC_1618` and every other existing test
using this crash-injection technique (`TC_2873`, `TC_752`, `TC_589`, `TC_1430`, and more) sends the
assert (`-o 0`) command to force a camera crash but **never sends the de-assert (`-o 1`) command
afterward** — and grepping the entire `nd_core_utils` tree found that `check_left/right_cam_boot_status()`
(the only functions that call `reset_left/right_cam()`) have **zero callers anywhere**, and the
actual runtime crash-handling path (`nd_central.cpp`'s `cam_num %d is crashed` handler) never calls
them either — it only reads status afterward. So nothing recovers these cameras: existing precedent
tests may be leaving lab devices with a crashed side camera indefinitely between runs. Not filed
anywhere yet — added as row 8 to the defects table below. **When copying any GPIO-based fault
injection technique from an existing test, check the device source for a corresponding
release/de-assert command before assuming the crash is self-clearing or already cleaned up
elsewhere** — don't just trust that an existing, currently-used test's absence of cleanup means
cleanup isn't needed.

---

## 4. Known framework defects — catalogued for potential escalation

None of these have been filed anywhere. All are read from source and/or confirmed by real
device behavior, not guessed.

| # | Where | What | Evidence |
|---|---|---|---|
| 1 | `Config_api.py` `file_availability`-based check in `download_config` | Intermittent false negative ("file not present" when it is) | Same file, same device, two consecutive runs, different results |
| 2 | `Config_api.py:451` `upload_config`'s backup `mv` | No exit-status check | Read directly; a silent failure is indistinguishable from success in logs |
| 3 | `ssh.py:~144` `get_file()` | Verifies destination *exists*, never that content changed | Directly caused a stale-cache bug this session |
| 4 | `Config_api.py` `_sync_md5_backup` interaction with SVC `config_recovery` | Marks a test's *temporary* modification as the device's permanent "correct" reference state | Manual fix silently reverted ~15 min later; root-caused via md5 backup dir inspection |
| 5 | `dictionary_api.py` `force_to: "NA"` handling | Skips `_execute_postconditions()`, unlike the Pass/Fail force_to paths | Read directly in the exception-handling block |
| 6 | `speed`/`bagheera` boot-ordering race (device-level, not framework) | `speed` tries to open `bagheera`'s message queue ~1.5–1.7s before `bagheera` creates it; notification silently dropped, no retry | Reproduced 2/2 attempts on device `264065431`; see `out/DT-3961/execution_1_failure_analysis.json` |
| 7 | `dictionary_api.py` `Workflow.execute()` — PreCondition-iteration loop vs. main step-loop | A `"continue to <X>"` jump (and likely `force_to`) issued from a `PreCondition_N`'s `validate_data` is silently ignored — the PreCondition loop tracks its own `steps_to_process` variable, which never flows into `current_step`; the main loop still starts unconditionally at `STEP_1` regardless. Jumps issued from a regular `STEP` work correctly (precedented in `TC_4127`'s `STEP_4_1`) — this is specific to PreConditions. | Reproduced on device `264065431` running `TC_3159` (DT-525): `PreCondition_2` tried to skip to `PostCondition_1` on a missing baseline; `STEP_1`–`STEP_5` ran anyway. Independently corroborated by prior user experience with `force_to` in a PreCondition. Workaround: gate in `STEP_1` instead of a `PreCondition`, or accept the test runs through and rely on backup/restore safety nets. |
| 8 | `TC_1618`, `TC_2873`, `TC_752`, `TC_589`, `TC_1430`, and other existing tests using `gpio_test -n <pin> -o 0` to force a side/front/inward camera crash | Never send the corresponding `-o 1` de-assert command afterward — these GPIO commands are level signals (assert/de-assert a physical reset line), not momentary pulses; nothing in the runtime crash-handling path recovers the camera either. Devices these tests run on may be left with a crashed camera indefinitely between runs. | Confirmed via source: `nd_core_utils/cpp/src/nd_device_bag3.cpp:72-73,241-242,271-272` names these exact GPIO pins/commands `LS/RS_CAM_RST_GPIO` and `left/right_cam_reset_cmd` (assert) vs. `left/right_cam_oo_reset_cmd` (release); grepped the whole repo for callers of the only functions that ever call the release side (`check_left/right_cam_boot_status()`) — zero call sites anywhere. Found while building DT-4501's candidate, which adds its own explicit release PostCondition rather than repeating the gap. |

---

## 5. Operational tactics for running a test on real hardware

- **Always do a dry-run of the full import chain before touching a device.** `main.py --help`
  only proves top-level imports work — it does **not** construct a `Step` object, so it misses
  entire classes of missing-dependency crashes (§3.8). The real check:
  ```bash
  export BASE_PATH="<Test_Automation_Framework abs path>"
  export device_id="<id>"; export device_type="<krait|krait2|bagheera...>"
  cd "$BASE_PATH/src" && python3 -c "
  import sys; sys.path.append('..')
  import importlib
  mods = [ ... ]  # every module Step.__init__ imports -- grep dictionary_api.py for the list
  for m in mods:
      try: importlib.import_module(m)
      except Exception as e: print('FAIL', m, e)
  "
  ```
  This caught `psycopg2`, `pandas`, `python-dotenv` missing, and a `device_type`-dependent
  `TypeError` in `camera_api.py` — none of which `--help` would ever surface.

- **Don't run with `-j` (`--jenkins`) on an isolated/local machine if you can avoid it.** It skips
  starting the GRPC server, but Mongo access still routes through a GRPC-wrapped client
  (`Lib/db_handle/client.py`) — every Mongo touchpoint then eats a ~60s timeout before falling
  back to a local method. Running *without* `-j` avoided this entirely once the GRPC server could
  actually bind.

- **Do use `-j` on a shared machine** (like `dta_server`) where you can't safely claim the
  default GRPC port (`50051`) — it's very likely already bound by another concurrent job. Check
  `ss -tlnp | grep 50051` first either way.

- **Watch for the actual result, not "Traceback."** A bare `Traceback` grep pattern will false-
  positive on a harmless early-startup warning (an unrelated `bs4` import issue prints one on
  every run). Use an unambiguous, late-appearing marker instead:
  ```bash
  until grep -qE "status_document \{|did not finish in" "$LOG"; do sleep 5; done
  ```

- **Kill hung report-download tails proactively.** Once `status_document {...}` has appeared in
  the log, the actual test result is durably recorded — nothing useful comes from waiting for the
  subsequent Flask report-download step, which can hang well beyond its own designed retry bound.
  Kill the `main.py` process at that point rather than wait.

- **Before generating a config-touching test, snapshot ground truth first.** Read the live
  value(s) you're about to modify *before* running anything, via a direct read-only SSH check.
  This is what let a "no risk" call be made confidently for one run (the value being set already
  matched the existing baseline) and let a real corruption be caught precisely on another.

- **After any run touching `download_config`/`upload_config`/`reupload_config`, independently
  verify device state** — don't trust `PostCondition` log lines. Check the live file content and
  its md5 against the backup directory (§3.4).

---

## 6. Shared-infrastructure safety (learned the hard way — one real incident this session)

**What happened:** a blanket `pkill -9 -f 'report_generation.py'` on `dta_server` — intended to
clean up one lingering subprocess from this session's own test run — matched and killed **five**
processes, **four of which belonged to other active Jenkins jobs** with no relation to this work.
Recovery required real forensic effort (cross-referencing MongoDB collections by device-ID set to
reconstruct exactly which `Output_Collec`/`Input_Test_Collec` each job needed) and took far longer
than the mistake itself.

**Rules going forward, non-negotiable on any shared/multi-tenant machine:**

1. **Never kill by a bare command-name pattern.** `pkill -f 'report_generation.py'` matches
   *everyone's* process with that name. Always scope to the exact PID, or to a pattern specific
   enough that only your own invocation matches (e.g. include your exact port number and args:
   `pkill -f 'report_generation.py --run_from_framework True --port 500X'` where `500X` is
   *your* port, not a wildcard range).
2. **Before touching any process, list what's actually running and whose it is.** On a Jenkins
   agent, check `pgrep -af` broadly first, look at the working-directory path in the command line
   (Jenkins workspaces are self-descriptive, e.g. `.../jenkins/workspace/<job_name>/...`), and
   assume anything under a `jenkins/workspace/` path that isn't yours is live and load-bearing.
3. **Before switching branches or writing files on a shared checkout, check `git status`.**
   `git checkout <branch>` will safely refuse if it would overwrite real uncommitted work — when
   it does, `git stash push -m '<reason>'` (never `--force`, never discard) before retrying.
4. **If you must reconstruct lost state, verify by content, not by inference.** Timestamps looked
   plausible but were misleading for 4 of 5 processes in the incident above (their `Output_Collec`
   timestamps were *hours earlier* than their Jenkins `BUILD_TIMESTAMP`, for reasons never fully
   explained). What worked reliably: matching each candidate MongoDB collection's actual
   `device_id` values against each job's real, known device list (from its own `parameters.json`)
   until you get an **exact set match, zero ambiguity, zero overlap with any other candidate.**
   Don't restore based on a single weak signal (timing) when a strong one (exact content match)
   is available.
5. **Full transparency, immediately, the moment you realize a mistake affected something beyond
   your own scope.** Don't investigate quietly and report only once fixed — the user needs to
   know as soon as you know, because they may have context (who owns what, what's urgent) that
   changes the right next step.

---

## 7. `dta_server` specifics (172.16.23.15)

- SSH access is key-based, no password needed for the hop itself: `ssh dta_server@172.16.23.15`.
- This is a **Jenkins build agent**, not the Jenkins master — `/var/lib/jenkins` does not exist
  here, so build console logs are not locally readable; the master is a separate host
  (`build-device.netradyne.info`, per env vars observed on live job processes).
- `nd_test_bot` exists in **25+ separate checkouts** on this box: many under
  `jenkins/workspace/<job>[@N]/` (Jenkins-managed, active CI — do not touch), and a handful of
  personal/manual ones directly under `/home/dta_server/` (`shankar/`, `AI_Gen/`,
  `Test_automation/`, and a bare `nd_test_bot/`). **Ask which to use — don't guess.** This
  session used `/home/dta_server/shankar/nd_test_bot`, checked out to `BI_6.16_20251108`
  (matching the branch used for all local validation).
- The environment here already has all Python deps installed and MongoDB running — **no venv
  setup needed**, unlike the local machine.
- To reach the actual test device from here, a *second* SSH hop is required (device is not
  reachable from outside the company network) — same device credentials as used elsewhere, but
  ask for the current password each time; it rotates and a stale one will simply fail
  authentication (confirmed: an old password was silently rejected mid-session with no
  ambiguity — `Permission denied`, not a hang).

---

## 8. Local environment notes (this machine, not `dta_server`)

- `repos/nd_test_bot` working tree checked out to a local branch `BI_6.16_20251108_local`
  tracking `origin/BI_6.16_20251108`.
- Project-local venv at `.venv/` (not system Python — Python 3.12 here has no PEP-668 workaround
  needed since a venv sidesteps `externally-managed-environment` entirely).
- **`numpy==1.24.4`** (pinned in `requirements.txt`) has no Python 3.12 wheel and needs the
  removed `distutils` to build from source. It's only needed for PDF/report generation
  (`matplotlib`, `reportlab`), not for running tests via CLI. Fix: install everything else
  unpinned, skip `numpy`/its heavy dependents unless you specifically need report generation
  locally too (in which case install a modern unpinned `numpy` — it works fine, just not the
  pinned ancient version).
- Full dependency list that turned out to be needed beyond the obvious ones (discovered
  incrementally, each one a real crash before being found): `psycopg2-binary` (not plain
  `psycopg2` — avoids needing Postgres client headers), `pandas`, `python-dotenv`, `boto3`,
  `pytz`, `reportlab`, `matplotlib`, `setproctitle`, `grpcio`, `protobuf`, `bs4`.
- `mongod` needs to be actually running locally (`systemctl status mongod`) for any of this to
  work at all — confirm before debugging anything else.

---

## 9. Bug-analysis / test-generation tactics (the "AI reasoning" half, not the deterministic half)

- **Different Jira projects use different custom field names for the same concept — don't assume
  DT's field names are universal.** Confirmed real: OCTO tickets have no "Root Cause Description"/
  "Resolution Description" fields at all (checked a real ticket's full field list). `normalize_bug()`
  correctly returns `""` for both there, not an error, but that used to mean `extract_oracle_candidates()`
  had almost nothing to rank against beyond the summary. Fixed by folding `description` (log-line-
  stripped) into the oracle-ranking query as a permanent addition, not just an OCTO-only special
  case — every project benefits from more real evidence, not less.
- **Adding more query text to a flat token-overlap ranker can make it WORSE, not better — verify
  with a real before/after comparison, don't assume more evidence always helps.** Confirmed real:
  including a ~140-token OCTO description alongside a 10-token summary initially DROPPED the
  correct oracle candidate from rank #6 to rank #37, because generic words shared across many
  unrelated `LOG_*` lines ("read", "failed", "set", "default") outscored the one line that actually
  mattered by raw count. Fixed by switching to IDF-weighted scoring (document frequency computed
  over the ticket's own candidate log-line pool) instead of a flat overlap count — a shared rare
  word ("voltage") now counts for more than a shared common one ("read"). Verified against both
  the OCTO ticket (moved from rank #37 back up to #4, better than the pre-change baseline of #6)
  and four already-validated DT tickets (no regression — the known-correct oracle still ranks #1
  for DT-3948 after the change). Lesson generalizes beyond this one fix: any time a ranking
  signal's input text is broadened, re-verify the ranking on a real case rather than assuming the
  change is strictly additive.
- **Component inference should check labels first, then Jira comments, then a weak token-match
  fallback — never trust the weak fallback without a warning.** Confirmed real false positives
  from the weak fallback (`GPS` matched from an incidental mention of an unrelated sensor
  category; `SPEED` matched from a pasted raw log line about an unrelated thread). Fixed by
  stripping lines matching the device logger's fixed shape
  (`^\s*\d{10,14}:\s*\d+:\s*\S*:\s*[A-Za-z]:\s*\d+:\s*\d+:`) before tokenizing for the fallback —
  this removed the false positives without losing genuine prose-based signal. **Comments are not
  currently fed into `bugreg_research.py`'s component inference at all** — this was a real gap;
  DT-3961's correct component only surfaced because a human/AI read the comments directly. Worth
  fixing in the tool itself, not just working around by hand each time.
- **Rank oracle log-line candidates by overlap with root-cause/resolution text, not summary
  text.** A bug's summary describes the user-visible symptom in the reporter's words; the actual
  fix's log lines use the developer's variable names, which show up in Root Cause / Resolution
  fields, not the summary. Ranking against summary alone buried the correct oracle below a
  20-candidate cutoff in one real case.
- **When ticket evidence conflicts internally, don't silently pick a side.** DT-4290's own
  tables disagreed with its own prose about a threshold's expected value. The right move: take
  the most direct, least-processed human statement as the working assumption, mark confidence
  accordingly low, and name a specific person/mechanism to resolve it (e.g. "confirm with the PR
  author") rather than either guessing confidently or refusing to generate anything.
- **Do the coverage-mapping due diligence by actually reading candidate existing tests, not just
  trusting a similarity score.** In every ticket this session, the top-scoring "similar test" by
  lexical score was *not* the one that actually mattered (once opened and read, several
  high-scoring candidates turned out to be about a completely different subsystem that happened
  to share vocabulary). The test that actually mattered sometimes scored far down the list.
- **Generate less than what's specified when the rest isn't evidenced.** Both DT-3948 and
  DT-4290 had a linked Jira `TestCase` ticket specifying more scenarios than the bug's own fix
  touches. Generating only the evidenced subset, with an explicit note about what was left out
  and why, was treated as correct discipline, not incompleteness.
  **Updated by explicit user policy after DT-2275 (standing rule, applies to every ticket from
  here on — see below): this only applies to scenarios the ticket's evidence doesn't actually
  support at all. It does NOT license skipping a scenario the ticket does specify just because
  reproducing it takes real work (config changes, a relay, a service message). Those must be
  built, not named as a gap.**
- **Standing coverage-bar policy (explicit user instruction, applies to every ticket from now on,
  not just the one that prompted it):**
  1. Cover every scenario the ticket specifies or implies, even if reproducing it requires
     forceful simulation — config changes, `SendMsgServer_obj` messages, relay hardware, whatever
     it takes. Real example: DT-2275 named privacy 0/1/2, ignition 0/1, and full/partial sessions
     — six scenarios, all built, none downgraded to "too much effort."
  2. Default to **multiple candidate files** when scenarios have genuinely different
     preconditions/triggers — one file per scenario-family, cross-referenced in each other's
     `bug_analysis.json` (not their docstrings — see the 2026-08-19 entry below). Only combine
     into one file when scenarios share a precondition/fixture and can run back-to-back safely.
  3. **Exhaustively mine `nd_test_bot`'s own existing tests for forcing techniques before
     inventing anything.** Real examples this surfaced fast that would have taken much longer to
     derive from source alone: `SendMsgServer_obj.long_press()` (no-hardware simulated button
     press over TCP) and an existing test's double-service-restart trick for forcing a session to
     end early. A research subagent is worth it when the search spans multiple keywords or needs
     cross-referencing config sections against message handlers.
  4. **A documented gap is only honest after that exhaustive search comes up empty everywhere**
     (confirmed real example: DT-2275's geofence-triggered privacy mode — zero config key, zero
     message-injection method anywhere in `Lib/apis/*.py` or any existing test). A config flag, a
     message, or a relay call are buildable, not gaps — don't reach for "documented limitation" as
     a shortcut past real work.
  5. **When the only blocker is needing real device access, just ask for it directly and proceed
     once given it** — that's a resource request, not a design decision requiring deliberation.
     Genuine design ambiguity still deserves a real question; "I need a device" doesn't.
- **Jira's "Linked Work Items" can contain a linked TestCase (TC-project) ticket — fetch its full
  content and treat it as at least as authoritative as the PR diff, not an optional supplement.**
  `bugreg_research.py` does this automatically now (Step 1.4: fetches Preconditions/Test
  Steps/Expected Result by Jira field NAME, not a hardcoded custom-field ID, since those IDs
  aren't portable across Jira instances). Real example that motivated adding this (DT-4501,
  linked TC-4260): the PR diff alone (correcting which I2C register a crash-classification check
  reads) would suggest asserting one specific log line after forcing a camera crash. TC-4260's own
  "Expected Result" field said outright "either of the 2 logs should come" — revealing that which
  branch fires is genuinely hardware-nondeterministic, and the only correct oracle is a
  correlation/implication check ("whichever branch fired, the classification must match it"), not
  a fixed-expected-value assertion. TC-4260 also supplied the exact manual force-the-bug commands
  (`i2cset`/`gpio_test`) and a `Service/Component Name` field ("Bagheera") that resolved a
  component-inference guess the automated step alone returned empty for. A PR diff shows the fixed
  *code*; a linked TC ticket, when a human wrote one to verify the fix, shows what they actually
  *did* and *observed* on real hardware — read it before designing anything, it can change the
  test's entire shape, not just add color.
- **A ticket's own "Resolved" status and a currently-failing regression test are not
  contradictory** if the failing test's mechanism differs from what that ticket's fix touched.
  Always check the actual fix commit's changed-file list before assuming a resolved ticket
  implies a currently-passing test — DT-3961's fix touched zero lines of the two source files
  where a *different*, still-live defect was later found.
- **(2026-08-19, explicit user policy change) Candidate `.py` files carry only a single one-line
  docstring — source ticket + one-sentence purpose — nothing else.** No PR links, before/after
  narrative, oracle rationale, scope/gap discussion, framework-defect writeups, or generated-
  by/status footer belong in the test file itself anymore. All of that moves into
  `bug_analysis.json`, which already sits next to the candidate in `out/DT-XXXX/` — see its
  `framework_defects_found_on_real_hardware` and `device_validation` sections (added for DT-525/
  TC_3159 as the first example) for the shape real-device findings and two-device validation
  results now take. Rationale: the previous convention (an elaborate multi-section docstring,
  e.g. TC_3159's original ~140-line header) duplicated `bug_analysis.json` and was judged not
  worth carrying in the file a device actually executes. `promote_candidate.py`'s
  `derive_description()` was updated the same day to match — its old regex required a newline
  right after the opening `"""`, which a same-line one-liner never has, so it was silently falling
  back to the bare filename as the `main_db.xlsx` description column before the fix.

---

## 10. If picking this project back up: recommended next steps (as of end of this session)

1. Fix the two structural gaps identified in §9 inside `bugreg_research.py` itself (feed
   comments into component inference; consider whether service-name-vs-log-folder-name (§3.6)
   can be checked deterministically against a real systemd unit list per platform).
2. Decide whether to escalate the `speed`/`bagheera` race finding (`out/DT-3961/
   execution_1_failure_analysis.json`) and/or the framework defects in §4 to whoever owns them —
   nothing has been filed anywhere; both are drafts by design.
3. DT-3948's actual fix (`scan_required=1` firing a real fallback scan) remains unproven on any
   device tested so far, because both available test devices maintain a persistent WiFi
   association across reboot and never enter the "no IP after boot" state the fix addresses. A
   device or mechanism that genuinely produces that state is needed before this can be called
   validated, not just "didn't regress."
4. The "sufficient information" gate the user asked for (explicitly refuse/flag generation when
   a ticket lacks critical fields, rather than generate on thin evidence) was discussed but not
   yet built — see the Tier A/B/C/D analysis referenced in this session as the starting point for
   its design.
