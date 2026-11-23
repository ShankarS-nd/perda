---
name: bug-regression
description: Turn a Netradyne Jira bug ticket (DT or OCTO project) into a validated, PR-diff-grounded nd_test_bot regression test — research, AI bug analysis, candidate generation, static validation, and real-device validation on both a fixed and an unfixed device.
---

# Bug-to-Regression Testcase Skill

You are running the Netradyne bug-to-regression pipeline: turning a Jira bug ticket into a
trustworthy, human-reviewed `nd_test_bot` regression test. This skill packages the process and
every hard-won lesson from building and using it for real — read this whole file before doing
anything, then follow it. It exists so a fresh session performs at the same quality bar as one
that has already spent hours discovering these lessons the hard way.

**If invoked with a Jira ticket key** (e.g. `DT-1234`) as an argument: run Steps 1-4 below
**continuously, in one turn, without stopping to ask permission between them.** Research,
reading the diffs, writing `bug_analysis.json`, writing the candidate, and static validation are
all either deterministic or your own judgment — none of them need a human decision, so don't
introduce one. The first point where you actually stop and wait is Step 6 (human review) — that's
a real checkpoint, not a formality, so don't skip past it the other direction either. If Step 4's
validation fails, fix it and re-validate yourself before presenting anything, the same way you'd
fix a real device-run failure — don't hand a human a candidate you already know is broken.

**If invoked with something else** (a file path, "validate X", "run TC_1234 on device Y", "check
the other repos") — do just that specific step; don't restart the whole pipeline unless asked.
**"Run/test this on a device" specifically means Steps 7-10, starting with creating the candidate's
Jira TC subtask (§7) — not just Step 9's run.** A device run whose ticket doesn't exist reports as
"Not Executed" no matter how well it goes.

## The one sentence that governs everything else

Deterministic code does the mechanical work (Jira/GitHub API calls, git search, xlsx parsing,
static validation); you do the semantic reasoning (understanding the bug, writing the test,
judging whether evidence is sufficient); a human decides what becomes real. Never blur that last
line — this tool never auto-commits, never auto-pushes, and never promotes a candidate out of
"pending review" on its own. It files exactly one kind of Jira issue, and only when you're asked to
run a candidate on a device: the TC subtask that run's result gets attributed to (§7). Nothing in
the `DT`/`OCTO` bug projects, no transitions, no comments, ever.

---

## The coverage bar — standing rule, every ticket, not a one-off for DT-2275

**Cover every scenario the ticket actually specifies or implies — not just the first, easiest, or
most-evidenced one.** DT-2275 named privacy mode (0/1/2), ignition status (0/1), full and partial
sessions — six distinct scenarios across five files, not one test that covers "the fix generally
exists." That's the bar going forward, for every ticket, not a one-time exception.

- **If forcing a scenario needs config changes, a service message, relay hardware, or anything
  else — DO it.** Don't downgrade a real, in-scope scenario to a "named gap" just because
  simulating it takes real work. A gap is only honest when NO lever exists anywhere in the
  framework after an exhaustive search (confirmed real example: `privacymode_geofence` — zero
  config key, zero message-injection method, anywhere in `Lib/apis/*.py` or any existing test,
  after an exhaustive `grep`, not a five-minute look). Everything else — a config flag, a
  `SendMsgServer_obj` message, a relay call — counts as buildable, not a gap. (This is distinct
  from generating a scenario the ticket's evidence doesn't actually support at all — inventing
  untested territory beyond what the fix touches is still the wrong direction; the bar is "cover
  what's actually in scope, thoroughly," not "pad the coverage with speculation.")
- **Write multiple candidate files by default when scenarios have genuinely different
  preconditions** (different config, different trigger, different session type) — one file per
  scenario-family, cross-referenced in each other's `bug_analysis.json`, rather than one overloaded file.
  Combine into one file with multiple scenario blocks only when scenarios share the same
  precondition/fixture and can safely run in sequence (e.g. TC_3196's 0-then-1 privacy cases,
  same config, same reboot).
- **Exhaustively mine `nd_test_bot` itself before inventing any technique.** The fastest, most
  reliable way to find a forcing technique is an existing test that already does it — searching
  for existing tests by keyword (privacy, off-duty, partial, geofence, ...) surfaced
  `SendMsgServer_obj.long_press()` (a button-press simulated over TCP, zero hardware) and
  `TC_1405`'s double-service-restart trick for forcing a partial session — both faster and more
  reliable to find by searching than to derive from reading source alone. Use the `Explore` agent
  or a dedicated research subagent for this when the search is non-trivial (multiple keywords,
  cross-referencing config sections against message handlers) — this found the privacy-mode enum,
  every forcing technique, and the one real geofence gap in a single pass. Read actual source
  (`nd_central.cpp`, `device_mode.h`, etc.) to resolve anything a test's own comments leave
  ambiguous or self-contradictory — trust the code and empirical device behavior over comments.
- **When the only blocker to attempting a scenario is needing real device access, don't stop and
  ask permission — just ask for the device/credentials directly and proceed the moment you have
  them.** This is different from a genuine design decision (which still deserves a real
  question) — "I need a device" is a resource request, not a decision point.
- **Empirically verify anything ambiguous or self-contradictory in existing comments/docs before
  trusting it** — a real example: `TC_3425`'s own comments contradicted each other about what
  `SerialCom_obj.call_relay(["on"/"off"])` means; resolved by running a throwaway investigation
  script against a real device and reading the exact resulting log lines, not by picking whichever
  comment sounded more confident.

---

## 0. One-time setup (check before assuming it's done)

- A `.env` file at the project root with `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`,
  `JIRA_AUTH_MODE=cloud`, and (optional, often stale/invalid — don't rely on it) `GITHUB_TOKEN`.
- `repos/nd_device_services`, `repos/nd_core_utils`, `repos/nd_test_bot` cloned under the project
  root. If a ticket's linked PR lives in a repo you don't have yet, clone it —
  `cd repos && git clone git@github.com:netradyne/<repo>.git` — SSH access to GitHub is usually
  fine even when `GITHUB_TOKEN` (HTTPS/API) isn't; check with `ssh -o BatchMode=yes git@github.com`
  before assuming either way.
- A Python venv with `pandas`, `openpyxl`, and the rest of `nd_test_bot`'s `requirements.txt`
  (skip the pinned ancient `numpy` unless you need local report/PDF generation — see the bundled
  `docs/SESSION_LEARNINGS.md §8` for the exact dependency list this bites you with).
- The scripts in `scripts/` resolve their project root from `--project-root`, then
  `$BUGREG_PROJECT_ROOT`, then the current working directory — run them from the project root, or
  pass one explicitly. They expect `.env` and `repos/` there.

**If the current project root is missing `.env`, `repos/`, or the venv, stop and say so — never go
looking elsewhere on the machine for an existing checkout that happens to have them.** This skill
is distributed independently of any particular project (e.g. as a plugin), so there is no
guaranteed "the real setup lives at path X" to fall back to — a teammate running this for the first
time will have *no* other project with these resources anywhere on their disk, and even on a
machine that happens to have an unrelated project with its own `.env`/repos, silently borrowing
those is a correctness and credential-scoping risk (wrong Jira token, wrong repo checkout), not a
convenience. Tell the user exactly what's missing from the current project root and let them decide
whether to set it up here or point you at a different `--project-root`/`$BUGREG_PROJECT_ROOT` —
don't search for it yourself.

---

## 1. Gather evidence (deterministic — run the script, don't hand-roll this)

```bash
python3 <this-skill-dir>/scripts/bugreg_research.py DT-XXXX --branch <target-branch>
```

This does seven jobs and writes `out/DT-XXXX/research_bundle.json` (+ readable `.md`): fetch the
Jira ticket; find matching commits by grepping git history; **query Jira's Development panel via
the dev-status API for authoritative linked PRs, and compute a real local `git diff` between each
merged PR's actual source/destination branches** (this is the single highest-leverage step — see
§5 below for why); **fetch the full content of any Jira "Linked Work Items" typed `Test`** (a
linked TC-project ticket) — preconditions, test steps, and expected result, looked up by Jira
field NAME rather than a hardcoded custom-field ID, since those IDs aren't portable across
differently-configured Jira instances; extract candidate oracle log lines; build the DSL
capability manifest for the branch; load `main_db.xlsx` and guess the affected component.

Read the printed output as it runs. If a linked PR comes back `unavailable` (repo not cloned, no
resolvable diff), that's a real evidence gap for this ticket — carry it into `bug_analysis.json`
later, don't silently drop it.

**A linked TestCase ticket, when one exists, can outrank the PR diff as evidence — always read it
before designing the candidate.** A PR diff shows the fixed *code*; a linked TC ticket (when a
human wrote one to verify the fix) shows what they actually *did* and *observed* on real hardware:
the exact manual commands to force the bug's trigger condition, the exact expected log output, and
often which outcomes are legitimately variable (not a bug) versus which indicate a regression. Real
example (DT-4501/TC-4260): the PR diff alone would suggest checking for one specific log line after
forcing a camera crash; the linked TC ticket explicitly stated "either of the 2 logs should come" —
revealing that the *correct* oracle is a correlation/implication check ("whichever branch fired,
the classification must match it"), not a fixed-expected-value check, which is a materially
different (and correct) test design entirely. It also supplied the real force-the-bug commands
(`i2cset`/`gpio_test`) and the ticket's own `Service/Component Name` field, which resolved a
component-inference guess the automated step alone couldn't make.

## 2. Understand the bug — read the actual diffs, not just filenames

Open `research_bundle.json`'s `dev_status_prs` and **read every merged PR's diff line by line**,
not just its changed-file list. This is where most of the real understanding comes from — not
the Jira description. Concretely, across real tickets this session:

- A ticket can bundle **two functionally separate fixes** across two PRs — generating a test for
  only the first one you find is a real, easy mistake (happened for real: DT-3948's PR #2699 was
  invisible until the diff was actually read).
- A one-line diff (`false` → `true`) can be functionally meaningless without reading the
  surrounding function — trace how the changed value actually combines with everything else
  before asserting what "correct" means (DT-4290's `apm_pwr_disable_sensor_24V` AND-combination
  logic).
- The ticket's own comments often contain the real field mechanism in more precise language than
  the description (exact SQL error codes, log lines, root-cause diagnosis from the fixing
  engineer) — read all of them, they're evidence, not color commentary.
- **DT and OCTO are different Jira projects with different custom field conventions.** DT tickets
  populate structured `Root Cause Description` / `Resolution Description` fields; OCTO tickets
  don't have those fields at all (confirmed directly, not assumed) — for OCTO, `description` and
  comments are the *only* place the real technical detail lives. `bugreg_research.py` already
  handles this: it prints an explicit note when both structured fields come back empty, and oracle
  ranking automatically falls back to (log-line-stripped) `description` text, IDF-weighted so a
  long description doesn't drown out the right candidate under generic shared vocabulary. Still
  read the ranked list as candidates, not answers, on either project — same discipline either way.
  Both projects' fixes land in the same repos (`nd_device_services`/`nd_core_utils`/`nd_test_bot`)
  and use the same nd_test_bot DSL, so nothing else about the pipeline differs between them.
- If a PR shows up **DECLINED** in the dev-status results, that's real signal (an earlier attempt
  at this exact ticket that didn't ship) — note it in `bug_analysis.json` so nobody mistakes it for
  the real fix later; don't just filter it out silently.

**Mandatory duplicate check, before writing anything — this is a hard gate, not a suggestion.**
Before designing the test, actually open and read the top candidates from `coverage_mapping`
(and search the target service folder directly by keyword — don't stop at whatever score the
automated step assigned). Don't just trust the similarity score either way: the top-scoring
"similar test" is frequently about a different subsystem that happens to share vocabulary, and the
*actually* relevant existing test sometimes doesn't score highly at all (confirmed repeatedly this
session; worst case, the component-inference guess itself is wrong and points you at the wrong
folder entirely — DT-525's inference guessed "GPS", but the real, already-populated folder was
"TIMESYNC", found only by looking).

Having actually read them, make an explicit call:
- **If an existing test already exercises the same regression** (same fix, same trigger, same
  oracle, not just the same subsystem or vocabulary) — **do not generate a new candidate.** Stop,
  and tell the user plainly which test already covers it (file name + a one-line reason why it's
  the same scenario), so they don't get a redundant candidate they have to notice and reject
  themselves.
- **If existing tests are only adjacent** (same subsystem, different scenario/value/trigger) —
  proceed to generate, and say explicitly in your response (not just `bug_analysis.json`) which
  existing tests you checked and why they don't already cover this.
- **If nothing relevant exists** — proceed to generate, same as before.
This isn't optional busywork: generating a redundant candidate wastes the human reviewer's time
and dilutes the point of the coverage bar (§ above) — more tests should mean more real coverage,
not more near-duplicates.

Write `bug_analysis.json` (schema: see any `out/DT-*/bug_analysis.json` this project has already
produced, or the "Bug-analysis tactics" section of `docs/SESSION_LEARNINGS.md §9`), covering: what
broke, why, both/all fix commits, what's explicitly out of scope and why, a confidence score, and
what would raise or lower that confidence.

## 3. Write the candidate test

Use only methods that appear in the manifest (`out/_cache/manifest/<branch>.json`); oracle log
lines taken verbatim from real source or real Jira comments — never invented.

### Scenarios first, then testcases — one testcase per scenario, never one per platform

Before you write any file, write down the **scenarios**: the distinct behaviours the fix changes
that a device can show. Put them in `bug_analysis.json` as `"scenarios": [{"id": "S1", "what":
"<one sentence: the behaviour checked>", "families": ["octo", "bagheera3"], "differs_by_family":
"<only the path / command / unit name, or the behaviour itself>"}]`. Then write testcases from that
list:

1. **One testcase per scenario.** If a scenario applies to several families and only the *path,
   command, unit name, config file or expected value* differs, that is ONE testcase. It reads
   `device_type` (or probes the device, see "Probe and adapt" below) and picks the right path or
   command inside its steps. Do not write one file per platform for the same scenario.
2. **A separate file is justified only when the scenario itself is different** (a different
   behaviour is checked, or a lever exists on one family only), never because the commands are
   different. **A scenario is a behaviour, not a platform:** never write S1 for Octo and S2 for
   Bagheera3 when both must end in the same state. These are NOT reasons for a second file: "the
   boot config / file layout differs", "the commands differ", "one family has extra checks", "one
   file would need branching". Put the platform differences inside the one file: choose the path or
   command from `device_type`, and run a platform-only extra check (a recovery config that exists on
   one family) as a step that is skipped or NA elsewhere.
3. **Merge test before you finish:** compare your candidates with the scenario list. If two files
   share a scenario and differ only by platform commands or paths, merge them into one file with the
   platform handling inside, and delete the extra file.
4. **In `bug_analysis.json`, map each testcase file to the scenario ids it covers** (`"candidates":
   [{"file": ..., "scenarios": ["S1"], ...}]`).

A reviewer should be able to read the scenario list and see exactly what is verified, without
opening the files.

**The `.py` file itself gets a single one-line docstring — source ticket + one-sentence purpose,
nothing else.** e.g.:
```python
"""DT-525: Verify get_udid() recovers UDID from its persistent backup file instead of falling
back to hardcoded UDID=1 when UDID_TABLE is empty/corrupted at boot."""
```
No PR links, no before/after narrative, no oracle rationale, no scope/gap discussion, no
framework-defect writeups, no generated-by/status footer — none of that goes in the test file.
**All of it goes in `bug_analysis.json` instead**, which already sits right next to the candidate
in `out/DT-XXXX/` and is what a human reviewer (and you, in a later session) should actually read
for the "why." Specifically, `bug_analysis.json` must state: source ticket, exact fix commit(s)/PR(s)
(including any DECLINED ones, so nobody mistakes them for the real fix), before/after behavior, the
oracle and why it's trustworthy, and — critically — **what this candidate does NOT cover and why**,
whenever the ticket's evidence supports less than its full stated scope. When multiple candidate
files share a scenario-family, cross-reference them by filename inside `bug_analysis.json`, not in
each file's docstring.

**Every `PreCondition_N`/`STEP_N`/`PostCondition_N` entry gets a short (1-2 line) `#` comment
directly above it, in plain language, stating what that step does and why it's there** — e.g.
`# Toggle ignition off then on within the grace window so the session spans both privacy states
(mixed privacy), matching the field bug's trigger condition.` This is separate from, and in
addition to, the one-line file-level docstring above (which covers the ticket/purpose) and from
`validate_data`'s `pass_method`/`fail_method` messages (which are runtime pass/fail reporting, not
code readability) — the goal is that a reviewer can skim the comments top-to-bottom and understand
the whole test's flow without parsing every method/params/`validate_data` block. This mirrors a
convention already used by some existing tests (e.g. `TEST-SCENARIOS/TC_3429`'s `# ignition OFF`-
style comments) — just applied consistently to every step, not just a few.

**If a scenario genuinely can't be reproduced with the DSL's existing methods** (checked the
manifest, no lever for it — e.g. no way to force an SSID out of a live WiFi scan), say so
explicitly in `bug_analysis.json` rather than writing a step that can't truthfully exercise what it
claims to. An honest, documented gap beats a test that looks complete but silently can't do its
job.

Real-device validation results (Steps 9/10 below) also belong in `bug_analysis.json` — add/update a
`device_validation` section once a run against a fixed and/or unfixed device completes, rather than
appending a "Status" block to the test file. Framework defects or test defects discovered on real
hardware go in `bug_analysis.json` too (see `framework_defects_found_on_real_hardware` in any
`out/DT-*/bug_analysis.json` this project has already produced for the shape).

### Every candidate must be runnable on every platform — NA, never Fail, where it doesn't apply

A testcase lands on whatever device the suite happens to give it: `krait`, `krait2`, `bagheera`,
`bagheera2`, `bagheera3`, `octo`. **A krait-only test must come back NA on a bagheera, and a
bagheera-only test must come back NA on a krait — never Fail.** A Fail on a device the fix never
applied to is a false alarm: it costs a human a triage cycle, and once people learn to ignore that
test's failures it stops protecting anything at all.

Order of preference, strongest first:

1. **Probe and adapt.** Most family differences are a different path, unit name, binary name or
   config file for the *same* behaviour — those are not a reason to go NA. Discover the real one at
   runtime and carry on: `OVR=""; for f in /data/nd_files/config/bagheera_override.ini
   /home/ubuntu/config/bagheera_override.ini; do [ -f "$f" ] && { OVR="$f"; break; }; done`.
   (Real example: `out/DT-626/TC_4586_*.py` STEP_3.) A test that adapts covers both families for
   real; an NA covers neither.
2. **NA gate**, when the code under test genuinely only exists on one family (the fix touched only
   `conf/krait/*.spec` and Krait's `gst_recorder.cpp`; the service isn't installed on the other
   family at all; the hardware lever doesn't exist there). Exact shape (`PreCondition_1` by repo
   convention, `STEP_1` works identically — see the mechanics below):

```python
{
    "PreCondition_1": {
        "method": "Calculator_obj.get_device_info",
        "parameters": ["device_type"],
        "save_result": ["device_type"],
        "validate_data": [
            {
                "condition": 'device_type == "krait" or device_type == "krait2"',
                "pass_method": {"message": "Device is {device_type}", "action": "continue"},
                "fail_method": {
                    "message": "Device is {device_type} -- the use_ring_buffer config key exists only on krait/krait2",
                    "force_to": "NA",
                    "action": "exit"
                }
            }
        ]
    }
},
```

3. **Two sibling candidates**, one per family — **only when the two families check different
   behaviour** (see "Scenarios first" above), not when only the path, command or expected value
   differs: that is option 1. A different file path for the same check is NEVER a reason for a second
   file. If you do write siblings, give each its own NA gate, say in `bug_analysis.json` which
   scenario ids differ, and cross-reference them.

Mechanics that are easy to get wrong here:

- **`PreCondition_N` or `STEP_1` both work for an NA gate — but only with
  `{"ConsiderPrePost": "True"}` as the first `dict_list` entry.** `force_to: "NA"` from a
  PreCondition sets `PreCondition_N_status = "NA"` and raises; the PreCondition loop's handler
  runs `_execute_postconditions()` and returns, and `process_dict()` aggregates non-`STEP_`
  statuses into the verdict only when `ConsiderPrePost` is set — so without it the same gate
  reports Fail. Device-proven both ways (`TEST-SCENARIOS/TC_4621`, `TC_4622` and all 37
  `src/test_cases/DMS/` tests gate in `PreCondition_1`); the repo-wide convention is
  `PreCondition_1`, so prefer it for a plain family gate and use `STEP_1` when the gate needs a
  value an earlier STEP computed. What does **not** work from a PreCondition is a
  `"continue to <X>"` **jump** (§5) — that really is discarded. And there is no `STEP_0`: the
  executor starts at the literal `STEP_1`, so a gate written as `STEP_0` is dead code that lets
  the test run on the wrong device anyway.
- **Write the condition as a positive membership test of the families you support**, and let
  everything else fall into the NA branch. `get_device_info` returns whatever
  `os.environ["device_type"]` holds, which is `None` when the framework couldn't resolve it — an
  inverted gate (`device_type != "krait"`) reads that `None` as "must be the other family" and
  runs the whole test on an unknown device.
- **Say which family in the `fail_method` message, and why** — "Device is bagheera3 -- this GPIO
  reset line only exists on krait" is a reviewer-readable verdict; "not applicable" isn't.
- **State it in `bug_analysis.json`**: which families the candidate really covers, which it NAs
  out on, and what the evidence for that split is (which files the fix touched, which service is
  absent). A family restriction that isn't written down looks like a bug in the test later.

**An NA gate may only encode family/capability dependency — never fix presence.** Gating on
"does the fixed code exist here" makes the test NA on exactly the unfixed builds it's supposed to
catch, which is the one job it has. Deciding whether the *behaviour* is testable at all (a config
key the fix introduced being absent) is a different thing and belongs in a later step with an
honest Fail/exit — see `out/DT-626/TC_4586_*.py` STEP_2, which does that separately from its
STEP_1 family gate.

See §5 below for the DSL mechanics you need to get right the first time.

## 4. Validate statically (deterministic)

```bash
python3 <this-skill-dir>/scripts/validate_candidate.py \
    out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py \
    out/_cache/manifest/<branch-with-slashes-as-underscores>.json \
    <SERVICE> <branch>
```

Three gates (structure / vocabulary+arity / load) plus filename and ID-collision checks.
**Passing means "not obviously broken," not "correct."** It cannot check whether a string
argument corresponds to anything real on an actual device (a service name, a config key) — only
real hardware execution can, which is why Steps 7-10 are not optional.

## 5. Get the DSL mechanics right the first time (hard-won, not obvious from a quick read)

- `validate_data`'s `condition` is `eval()`'d with `__builtins__: None` — **no `int()`, `str()`,
  `len()`, `float()`, `print()`, or any builtin call is available.** Do numeric/string logic
  either on the device (inside the SSH command you run) or via `Calculator_obj`'s own methods
  (`add`, `compare_equal`, `compare_greater_equal`, ...), which do real Python arithmetic
  internally without needing the condition string itself to call anything.
- To reuse a value saved by an earlier step **inside a later step's `parameters`**, use
  `"use_result(varname)"` as (or within) a parameter string — **not** `"{varname}"`. `.format()`
  substitution (`{varname}`) only applies to `message` strings inside `pass_method`/`fail_method`;
  it is never applied to `parameters`. Confirmed directly in `dictionary_api.py`'s `Step.execute()`
  and cross-checked against real precedented tests (`TC_362`, `TC_377` in the `TIMESYNC` folder)
  that already use `use_result(...)` this way.
- **A `"continue to <X>"` jump (and likely `force_to`) issued from a `PreCondition_N`'s
  `validate_data` does not work** — it's silently ignored; the main step loop still starts
  unconditionally at `STEP_1` regardless of what a PreCondition's jump target says. The same
  pattern works fine from a regular `STEP`. Root cause: `Workflow.execute()` in
  `dictionary_api.py` runs PreConditions in a separate loop tracking its own bookkeeping variable
  that never feeds into the main loop's `current_step`. Confirmed on real hardware (DT-525/TC_3159)
  and independently corroborated by field use. **Workaround: put the gating check in `STEP_1`
  itself if the skip genuinely must work, or design the test so it's safe to run through anyway**
  (e.g. because a backup/restore precondition/postcondition doesn't depend on the skip).
- **Service names and log-folder names are not always interchangeable** — a folder name under
  `Output/logs/<service>/` can differ from the real systemd unit name (`ndcentral` the folder vs.
  `bagheera` the actual service, found only by a real device failure). Before trusting a service
  name string, grep for it inside an **existing, already-passing** test in the target repo
  (`grep -rn '"<name>"' src/test_cases/`) — if it's not used anywhere for `service_status`/
  `restart_service`, don't assume it, verify it (via `systemctl list-units` on the actual device
  if you have access, or by finding the real `.service` file in the repo's `scripts/` tree).
- **The device's login shell may not be bash.** One real device's `/bin/sh` was busybox `ash`,
  which doesn't support `[[ ]]`/`=~`. Worse: nesting `bash -c "..."` with only the inner double
  quotes escaped (not the inner `$` signs) gets silently mangled, because the *outer* shell still
  performs `$`-expansion inside its own double-quoted argument before the inner `bash -c` ever
  runs — this produced a command that always printed a wrong sentinel value regardless of the
  real file content, confirmed by reproducing it directly over raw SSH. **Prefer plain POSIX
  syntax (`case`/`[ ]`, no `[[ ]]`, no `=~`) over nested `bash -c` wherever possible** — it runs
  correctly under any shell with a single parsing pass and needs no escaping gymnastics.
- Running a raw `sqlite3 <path> "<SQL>"` command over SSH via `Calculator_obj.run_command_on_device`
  is a legitimate, already-precedented technique for direct DB inspection/manipulation (the
  framework's own `Calculator_api.get_hs_db_latest_entry_ts()` does exactly this) — safer and more
  surgical for reproducing a specific DB state (e.g. an empty table) than corrupting a file's raw
  bytes, which can trigger a different, undiffed recovery code path instead of the one you're
  trying to test.
- `main_db.xlsx` real column conventions (verified against ~400 sampled real rows, not guessed):
  `retry` and `isChildCase` should be **blank**, not `"No"` — `"No"` breaks a downstream
  `int(retry)` call. `Stable`/`<version>_Stable` = `"No"` is fine and honest for an unreviewed
  candidate. `Remark = "candidate, pending review"` is what actually marks a row as
  not-yet-approved — the Stable columns aren't even read by a direct `-t TC_id` run. 19 real
  columns: `file_name, description, time_in_seconds, isChildCase, retry, Stable, 6.8_Stable,
  6.9_Stable, 6.10_Stable, 6.10_OCTO_Stable, 6.11_Stable, 6.12_Stable, 6.14_Stable, 6.16_Stable,
  6.12_Bugs, DevPackage_Required, QA_Stable, Remark, Service_name`.

## 6. Human review (mandatory checkpoint — do not skip)

Read the generated file **and its `bug_analysis.json`** yourself, or have a human do it, before it
touches a real device or `main_db.xlsx`. Never auto-approve. If `bug_analysis.json` documents a
confidence caveat or coverage gap, resolve or accept it explicitly here, not silently later.

## 7. Create the Jira TC subtask — the trigger is "test it on a device"

**The moment you're asked to run a candidate on a real device, create its Jira TC ticket first,
before deploying and before the run.** Not after the run, not at sign-off.

```bash
python3 <this-skill-dir>/scripts/create_tc_ticket.py \
    out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py            # add --dry-run to look first
```

It creates a **Subtask under `TC-4574`** ("Testcases for 6.16 bugs using claude skill", project
`TC`) — the standing parent for everything this pipeline produces. Pass `--parent TC-XXXX` when a
ticket belongs under a different story; the default is right for ordinary bug-regression work.

Why it must happen before the run, not after: **the framework derives a run's Jira key from the
testcase filename.** A `TC_<id>` with no matching Jira ticket makes a genuinely passing run get
reported back as **"Not Executed"** — the run is wasted, and worse, an id that happens to belong to
somebody else's ticket silently attributes your result to unrelated work. That has happened for
real (see `TC-4588`, which exists specifically to replace a wrong reused id).

What the script does, and what it deliberately doesn't:

- Summary follows the existing convention on `TC-4574`'s subtasks exactly — the filename with the
  `TC_<id>_` prefix and `.py` suffix stripped, e.g.
  `BAGHEERA_GEOFENCE_MARKER_GATES_GPS_PUBLISH_AND_RESUMES`. Description links the source bug
  ticket and carries the candidate's one-line docstring.
- **Idempotent.** It reads the parent's existing subtasks first and, if one already has this
  summary, reports that key and creates nothing. Re-running it is safe — so re-run it rather than
  hand-checking whether a ticket exists.
- **It renames the local candidate to the id Jira handed back**, since the two must match. Jira
  assigns the number, so the id you guessed at generation time is usually wrong — that's expected,
  not a mistake to avoid. `--no-rename` skips it, and then reconciling the filename is on you.
- If the old id was **already deployed or already in `main_db.xlsx`**, it says so loudly and stops
  short of fixing it: remove the stale deployed file and its row, then run
  `promote_candidate.py` with the renamed file. It won't edit a shared checkout behind your back.
- It records the key in the candidate's `bug_analysis.json` (`jira_tc_subtasks`).
- It creates exactly one Subtask. It never transitions or resolves a ticket, never comments, never
  touches the parent, and never files anything in the `DT`/`OCTO` bug projects — those stay human
  actions (see § "The one sentence that governs everything else"). Creating the TC subtask is the
  single deliberate exception, and only because a device run is meaningless without it.

If ticket creation fails (VPN down, token expired, Jira rejects the parent), **stop and say so —
don't run on the device anyway.** The run would report as Not Executed and you'd have burned a
device slot for nothing.

## 8. Deploy + register

```bash
python3 <this-skill-dir>/scripts/promote_candidate.py \
    out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py --branch <branch>
```

One command, not a manual `cp` plus a manual `openpyxl` snippet. It re-runs `validate_candidate.py`'s
own gates internally first and **refuses to deploy anything that fails them** — same protection
as running validation separately, just enforced automatically instead of relying on remembering
to do it. It also refuses to silently overwrite a file that's already deployed at that path.
This does not replace Step 6 — run it only after a human has actually looked at the candidate.

## 9. Run on real hardware — mandatory, and genuinely, not to make it pass

**Prerequisite: §7 ran and the filename matches a real Jira TC ticket.** Check that before
touching a device, every time — it's the difference between a result that lands and one that
reports "Not Executed".

Real experience across every ticket this session: static generation from ticket + PR diffs gets
you roughly 80% of the way. The remaining 20% — a wrong service name, a missing precondition
check, a shell-quoting bug specific to one device's login shell, this exact PreCondition
control-flow defect — has *never once* been caught by static validation or careful `bug_analysis.json`
reasoning alone. **Only a real device run has ever caught it.** Treat this step as mandatory, not
optional, and treat "passed static validation" as necessary but nowhere near sufficient.

- **Always ask for the current device password — never assume one from earlier in this
  conversation or a prior session is still valid.** Passwords rotate — this is the one thing in
  the whole pipeline that genuinely cannot be automated away, and the only credential you should
  ever ask a human for. A framework-recorded password (e.g. in `src/parameters/parameters.json`)
  can be stale; update it once you have a confirmed-working one.
- **Don't guess the SSH username or ask the human for it — resolve it first.** Run
  `python3 <this-skill-dir>/scripts/detect_device.py <device_id>` before attempting any SSH
  connection. It queries the same MongoDB `ip_db.mycollection` the framework's own `set_env.py`
  uses (deviceID → deviceType/deviceIP), derives the username from device type
  (`krait`/`krait2` → `root`; `bagheera`/`bagheera2`/`bagheera3`/`octo` → `ubuntu`), and pings the
  IP to report whether it's directly reachable — all without needing an SSH login first, and
  without guessing (guessing wrong burns a login attempt against a real device). It refuses to
  guess for an unrecognized device type rather than pick one arbitrarily; confirm manually in
  that case, don't override it.
- Use its `reachable_directly` field to know whether to expect a jump-host hop. If the device
  isn't directly reachable, remember the remote checkout won't have your local changes
  automatically — copy the candidate file (and `main_db.xlsx`) over explicitly.
- **Check `ss -tlnp | grep 50051` before deciding whether to pass `-j`/`--jenkins` — don't
  default to adding it.** `-j` means "skip starting your own local GRPC server," which only helps
  when another job's server is *already* listening on that port for you to share. If nothing is
  listening, omit `-j` entirely: `main.py` starts its own local server and every internal
  Mongo-wrapper call it makes throughout the run (bookkeeping, device-IP lookup, result reporting)
  succeeds immediately. Passing `-j` with no shared server present makes every one of those calls
  burn through 3 full retries (~3-4 min each) before falling back to local Mongo — confirmed
  directly: the identical candidate ran in well under a minute of setup overhead without `-j`,
  versus 25+ minutes of repeated gRPC-timeout noise with `-j` and nothing to share, before ever
  reaching `PreCondition_1`. Only pass `-j` when the port check shows it's actually occupied.
- Watch for a real completion marker, not a bare `Traceback` grep (harmless startup warnings can
  print one): `until grep -qE "status_document \{|did not finish in" "$LOG"; do sleep 5; done`.
- **When it fails, diagnose which of three things actually happened before touching anything**:
  (a) a real regression in the code under test, (b) a defect in the generated test itself, or (c)
  a framework/environment interaction. All three have happened for real. Don't assume (a) just
  because the ticket is marked Resolved; don't assume (b) just because it's a generated test.
- **Standing instruction from the user: whenever you genuinely confirm a real DEVICE/PRODUCT-side
  bug during testing — case (a) above (a real regression or misbehavior in nd_device_services,
  nd_core_utils, or the actual service/firmware running on the device) — tell them immediately, in
  the same turn you confirm it, not buried only in `bug_analysis.json` for later.** "Confirm" means
  you've actually verified it (read the real device log/state, reproduced it, or traced the
  mechanism in the device-service source) — not "the test failed, therefore something's wrong."
  State plainly: what the bug is, how you verified it's real, your assessment of its severity, and
  why it matters (blast radius, who else it likely affects, whether it's silent/easy to miss). This
  applies throughout the whole pipeline, not just Step 9 — research (§1-2) or source-tracing can
  also surface a real device-side issue.
  **Explicit scope correction (2026-09-22): nd_test_bot FRAMEWORK bugs — main.py, Config_api.py,
  promote_candidate.py, or any other test-automation-tooling defect (case (c) above) — are OUT of
  scope for this "report immediately" behavior.** Those are our own tooling: fix them as needed and
  document them in `bug_analysis.json`/memory for future sessions, but do not proactively announce
  them to the user as if they were findings — mention one only if directly asked, or if it's
  actively blocking progress and needs a decision. This correction followed a DT-4650 session where
  every bug reported that day turned out to be in nd_test_bot itself and none were device-side; the
  user wants testing-tool bugs fixed quietly, not reported as findings. Do still write confirmed
  device-side bugs into `bug_analysis.json`/memory as usual; the report to the user is in addition
  to that, not instead of it.
- **Never fix a failure by loosening the assertion, widening a threshold, or removing a check just
  to reach green.** If you can't find a legitimate reason a failure is wrong, it probably isn't —
  go find the real cause. A test that can be made to pass by adjusting itself isn't testing
  anything.
- **After any step that touches device config or a database file, independently verify the real
  device state** — don't trust a `PostCondition`'s own "restored successfully" log line. Read the
  actual file/DB content directly over SSH.

## 10. Confirm it fails without the fix — the other half of "done"

A regression test's entire job is telling fixed builds apart from unfixed ones. Run the same
candidate against a second device that predates the fix and confirm:

- It fails, **at the step whose oracle actually depends on the fix** — read the actual failing
  step, not just the overall `test_status`.
- The failure reason matches what the pre-fix source predicts (e.g. "this log line genuinely
  doesn't exist in this build").
- Device state was independently verified restored on this device too.

**When a genuinely comparable fix-absent device isn't available, say so explicitly in
`bug_analysis.json` as a documented gap** rather than silently skipping this or claiming full
confidence without it.

A candidate that has (1) genuinely passed on a device with the fix — every failure along the way
root-caused and fixed, never papered over — and (2) correctly failed, for the right reason, on a
device without the fix, is as close to "100%" as this process gets. Anything short of both is
still a candidate with a known, nameable gap — name it, don't overstate confidence.

## 11. Final sign-off

The candidate stays `Remark = "candidate, pending review"` until a human explicitly promotes it.
Never commit, never push, never merge, never transition/resolve/comment on any Jira ticket, never
touch the `DT`/`OCTO` bug ticket at all — all deliberate human actions, on purpose, every time.
The one Jira write this pipeline makes is creating the TC subtask in §7, and only on an explicit
"test it on a device".


## 12. Dashboard-driven stages

The perda dashboard (Release Tickets, Team status columns) starts this skill unattended through
the claude CLI, one stage at a time, with arguments of this shape:

```
dashboard-stage=<generate|validate|include|regenerate> ticket=<DT-XXXX> job=<id> result-file=<path>
    [device=<id>] [unfixed-device=<id>] [base-branch=<branch> [new-branch=<branch>] | target-branch=<branch>]
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
- **The ticket can never become an automated regression test**: `"outcome": "not_testable"`, with
  the reason in `summary`. The dashboard records Generated TCs as N/A and nobody is invited to
  run it again, so use this only for a permanent verdict, and only after the work to prove it:
  - **No lever exists.** The trigger cannot be produced by the framework (the fix is only
    reachable through something the rig cannot drive without breaking its own link, and no DSL
    method, service message, config key or relay call reaches it), confirmed by the exhaustive
    search the coverage bar requires, not a quick look. Name what you searched.
  - **There is no code change to test.** An analysis or investigation ticket with no fix, no
    linked PR and no linked test ticket; say which ticket carries the real fix if you can tell.
  - Write the full reasoning to `bug_analysis.json` (`not_covered_and_why`) as for any other
    ticket. Write no testcase file.
- **Anything that could change later is `failed`, never `not_testable`:** the fix PRs are not
  merged yet or the branch is still moving, the evidence is unreachable, the project root is not
  set up, validation could not be made to pass. Those tickets should be run again, and the
  dashboard keeps their cell open for that.

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
Every other rule stands: never push to `base-branch` or any existing branch (except in the
`target-branch=` form below), never force-push, never merge, never open a pull request, never touch
another repo, never change Jira.

1. `cd repos/nd_test_bot && git fetch origin <base-branch>`. If the branch is not on origin: `failed`.
2. New branch name: when the dashboard passes `new-branch=<branch>` the user chose the name: use
   exactly that, with no prefix and no suffix. If it already exists on origin
   (`git ls-remote --heads origin <name>`), do NOT add a suffix and push nothing: `failed`, "branch
   <name> already exists". Never `main` or `master`, and never the same as `base-branch`.
   Without `new-branch=`: `bugreg/<ticket>-on-<base-branch with "/" replaced by "-">`. If that name
   already exists on origin, append `-2`, `-3`, ...
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



## Standing safety rules (non-negotiable, apply regardless of which step you're on)

- Never commit or push git changes in the target repos.
- Never assume a device password from earlier in the conversation is still valid — ask again.
- Never run a blanket `pkill -f <pattern>` on shared/multi-tenant infrastructure — scope to an
  exact PID or a fully-specific argument pattern. (A real incident this project hit: 5 processes
  killed, 4 belonging to unrelated active jobs, from a pattern that was too broad.)
- Never force git operations (`--force`, `git reset --hard`) on a shared checkout; `git status`
  first, `git stash push -u` (never discard) if something blocks a branch switch.
- Never fabricate a test step for a scenario the DSL genuinely has no lever to reproduce — document
  the gap in `bug_analysis.json` instead.
- **Never let a candidate Fail on a device family its fix never applied to** — adapt to the family
  at runtime, or gate it NA in `PreCondition_1`/`STEP_1` (§3, "Every candidate must be runnable
  on every platform"). A krait-only test must be NA on bagheera and vice versa. Equally: **never gate on
  fix presence** — that turns the test NA on exactly the unfixed builds it exists to catch.
- **The only Jira write allowed is creating the TC subtask under `TC-4574` (§7), and only when
  you've been asked to run the candidate on a device.** Never transition, resolve, comment on, or
  edit any ticket — and never touch the source `DT`/`OCTO` bug ticket in any way.
- **Any device-state change a candidate makes must be reverted by the end of the test — config
  files, GPIO/hardware state, service restarts, DB rows, anything.** Config-file revert
  (`reupload_config` + reboot) is already established practice; the same standard applies to
  *every* other kind of change, not just config. Real gap found and fixed this way (DT-4501):
  `gpio_test -o 0`/`-o 1` are assert/de-assert pairs for a physical reset line, not momentary
  pulses — an existing, currently-used test (`TC_1618`) crashes a camera via `-o 0` and never
  sends `-o 1` afterward, and nothing in the runtime path recovers it either (see
  `docs/SESSION_LEARNINGS.md` §3.11 and defects-table row 8) — meaning that test may be leaving lab
  devices with a permanently crashed camera. **Don't assume an existing test's silence on cleanup
  means cleanup isn't needed — check what the change actually does (source, not just precedent)
  and add an explicit revert `PostCondition` whenever a candidate changes device state in a way
  that doesn't self-clear.** `ConsiderPrePost: True` ensures PostConditions still run even after an
  early `exit`, so this is always achievable regardless of where a STEP fails.

## Bundled reference material

- `scripts/create_tc_ticket.py` — creates a candidate's Jira TC subtask under `TC-4574` and
  renames the file to match the key (§7). `--dry-run` shows what it would do.
- `docs/HOW_THE_TOOL_WORKS.md` — the pipeline explained in plain language, with real examples.
- `docs/USAGE_GUIDE.md` — the same process as this file, written as a standalone step-by-step
  runbook (useful if you want the non-skill version, or to hand to a human).
- `docs/SESSION_LEARNINGS.md` — the full, detailed catalogue this file's §5 and safety rules were
  distilled from: every framework defect found so far, `dta_server`-style shared-infrastructure
  notes, local environment/dependency gotchas, and bug-analysis tactics in more depth than fits
  here.
