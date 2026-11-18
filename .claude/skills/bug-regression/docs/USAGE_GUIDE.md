# Usage Guide — From a Jira Ticket to a Validated Testcase

**Audience:** anyone who has a Jira bug ticket (project `DT` or `OCTO` — both confirmed working;
their fixes land in the same repos and get tested via the same `nd_test_bot` DSL, just with
different Jira custom field names, which the tool accounts for automatically) and wants to end up
with a testcase in `nd_test_bot`, using this tool, without having to have lived through building it.

**Companion docs:**
- `docs/HOW_THE_TOOL_WORKS.md` — what each script does and why, in plain language.
- `docs/SESSION_LEARNINGS.md` — every gotcha, framework quirk, and safety rule found so far.
  This guide tells you *what* to run; that doc tells you *why something went wrong* if it does.

**Where you run these commands:** all `python3 out/...py` commands run from your project's
root (the directory containing `.env` and `repos/`), with your venv active
(`source .venv/bin/activate`). The same scripts are also bundled inside the `bug-regression`
skill at `<skill-dir>/scripts/`, resolving their own project root from `--project-root` /
`$BUGREG_PROJECT_ROOT` / cwd rather than assuming any fixed location.

---

## Quick reference (if you already know the flow)

```bash
# 1. Gather evidence (deterministic)
python3 out/bugreg_research.py DT-XXXX --branch BI_6.16_20251108

# 2. Read out/DT-XXXX/research_bundle.md, hand it to the AI step (Section 3 below) ->
#    produces out/DT-XXXX/bug_analysis.json and out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py

# 3. Validate the candidate (deterministic)
python3 out/validate_candidate.py \
    out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py \
    out/_cache/manifest/origin_BI_6.16_20251108.json \
    <SERVICE> origin/BI_6.16_20251108

# 4. Human review -> then, once you're going to run it on a device, create its Jira
#    TC subtask under TC-4574 and let it rename the file to the key it gets back (Section 5)
python3 .claude/skills/bug-regression/scripts/create_tc_ticket.py \
    out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py

# 5. Deploy + register in one command (Section 6)
python3 out/promote_candidate.py out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py --branch BI_6.16_20251108

# 6. Resolve device type/username/reachability without guessing (Section 7)
python3 out/detect_device.py <deviceID>

# 7. Run on real hardware, iterate until it genuinely passes -- not optional (Section 7-8)
python3 main.py -d <deviceID> -t TC_<id>

# 8. Run the same candidate on a device WITHOUT the fix -- confirm it fails, for the right
#    reason, at the step whose oracle depends on the fix (Section 9). This is the other half
#    of "done" -- a test that can't fail is not a test.
```

Everything below explains each of these in enough detail to actually do it the first time.

---

## Step 0 — One-time setup (skip if already done)

- `.env` at the repo root has real `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`,
  `JIRA_AUTH_MODE=cloud`. (`GITHUB_TOKEN` is present but currently invalid — not needed for
  anything in this flow; PR diffs are read via local `git`, not the GitHub API.)
- `repos/nd_device_services`, `repos/nd_core_utils`, `repos/nd_test_bot` are cloned. If a ticket's
  linked PR lives in a repo you don't have yet (Step 1 will tell you), clone it:
  `cd repos && git clone git@github.com:netradyne/<repo>.git` (SSH works even though the GitHub
  API token doesn't — confirmed on this machine).
- `.venv/` exists with `pandas`, `openpyxl`, and the rest of `requirements.txt` installed (see
  `docs/SESSION_LEARNINGS.md §8` for the exact dependency gotchas — `numpy` in particular).
- You know the **current** device password. It rotates — always ask, never reuse one from a
  previous session or an earlier run today.
- Know whether you're on the company network. If not, you'll need the `dta_server` hop in Step 6.

---

## Step 1 — Gather the evidence (deterministic, no AI, no guessing)

```bash
python3 out/bugreg_research.py DT-XXXX --branch BI_6.16_20251108
```

Replace `DT-XXXX` with the real ticket key and `BI_6.16_20251108` with whichever branch you're
targeting. This does seven jobs and writes `out/DT-XXXX/research_bundle.json` (+ a readable `.md`
copy):

1. Fetches the ticket from Jira (cached after the first fetch — `--refresh` to force a re-fetch).
2. Searches git history for commits/branches mentioning the ticket key.
3. **Checks Jira's Development panel for authoritative linked PRs** and, for every merged one,
   computes a real local `git diff` between its actual source/destination branches — this is the
   PR-diff grounding method; it doesn't guess from commit messages, it reads exactly what a human
   sees under "Development" on the ticket. If a linked PR's repo isn't cloned yet, it tells you by
   name instead of silently skipping it — go clone that repo (Step 0) and rerun.
4. **Checks Jira's "Linked Work Items" for any linked TestCase (TC-project) ticket** and, for each
   one, fetches its full Preconditions / Test Steps / Expected Result content (looked up by Jira
   field name, not a hardcoded custom-field ID, since those IDs differ across Jira instances). A
   linked TC ticket, when one exists, is often a human's own record of how they actually verified
   the fix on real hardware — read it, it can outrank the PR diff (see Step 2 below for why).
5. Extracts candidate log lines ("oracles") from the changed source files.
6. Builds/reuses the DSL capability manifest for the branch (every method a test may legally call).
7. Loads/reuses `main_db.xlsx` (what's already tested) and guesses the affected component.

**Read the printed output as it runs** — it tells you plainly if something is missing (no PRs
found, no linked TC ticket, no component guessed, etc.). That's a signal about how much of the
next step will be evidence-grounded vs. judgment-grounded, not a failure.

**Open `out/DT-XXXX/research_bundle.md`** before moving on. Look specifically at:
- "Linked PRs" — how many, which repos, whether each has a real diff or an `unavailable` reason.
- "Linked TestCase tickets" — if any exist, read the Steps and Expected Result in full before
  writing anything; don't just skim past this section into the PR diff.
- "Root cause" / "Resolution" fields — often more useful than the summary for what to test.
- "Coverage mapping" — existing tests that scored close; worth opening and reading, not trusting
  the score alone (§9 of SESSION_LEARNINGS explains why the top score is often the wrong test).

If a linked PR came back `unavailable` (repo not cloned, or no diff resolvable), that's a real
gap in your evidence for this ticket — don't silently proceed past it into Step 2 as if it weren't
there; note it, because it belongs in `bug_analysis.json` later.

---

## Step 2 — Understand the bug and design the test (this is the AI-judgment step)

This is not a script — it's a reasoning step, done by an AI (currently: Claude, in a
conversation) reading everything Step 1 produced. Hand it:
- `out/DT-XXXX/research_bundle.json` (or the `.md`, whichever is easier to paste/reference)
- the specific PR diffs inside it (read the actual before/after code change, not just the
  filenames — that's the whole point of Step 1.3)
- any linked TestCase ticket content (Step 1.4) — read this in full, in detail, before writing
  anything
- any Jira comments that weren't captured well by the automated component guess

**When a linked TestCase ticket exists, treat it as at least as authoritative as the PR diff, not
a nice-to-have supplement.** A PR diff is the fixed *code*; a linked TC ticket (when a human wrote
one) is a record of what they actually *did on real hardware* and *actually observed* — which can
reveal things a diff alone can't:
- **The correct oracle shape.** Real example (DT-4501/TC-4260): the diff alone would suggest
  asserting one specific log line after forcing a crash. The linked TC ticket said outright
  "either of the 2 logs should come" — i.e. which of two log branches fires is genuinely
  hardware-nondeterministic, and the *actual* correct regression assertion is a correlation check
  ("whichever branch fired, the downstream classification must match it"), not a fixed expected
  value. Missing this would have produced a flaky, wrong-shaped test.
- **The real forcing mechanism**, in the tester's own words — often the exact manual commands run
  on the device, which can be reused directly or cross-checked against (and preferred over, if
  already precedented — see §5's "mine nd_test_bot first" rule) the framework's own methods.
- **Component/service metadata** the automated inference step couldn't determine — DT-4501's own
  component guess came back empty; TC-4260's own `Service/Component Name` field said "Bagheera"
  directly.

Ask it to produce two things:

1. **`bug_analysis.json`** — a structured statement of what actually broke, what the fix changes,
   and a confidence rating for how well-evidenced that understanding is (a PR diff you can read
   line-by-line is much higher confidence than a bug description alone). If the ticket has
   multiple linked PRs, this must account for **all** of them, not just the first one found — a
   ticket can bundle two functionally separate fixes (this happened for real: DT-3948 has two
   merged PRs touching two different functions; a first pass generated a test for only one).
2. **The candidate test itself** — `out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py`, using only methods
   that appear in the manifest (`out/_cache/manifest/<branch>.json`) and oracle log lines taken
   verbatim from real source or real Jira comments (never invented). **The `.py` file itself gets
   only a single one-line docstring — source ticket + one-sentence purpose, nothing else** (no PR
   links, before/after narrative, oracle rationale, scope/gap discussion, or status footer). All of
   that — the source ticket, the exact fix commit/PR, the bug behavior before the fix, the expected
   behavior after, and — critically — **what this candidate does NOT cover and why**, if the
   ticket's evidence doesn't fully support broader scope — goes in `bug_analysis.json` instead,
   which sits right next to the candidate and is what a reviewer should actually read for the "why."
   **Every `PreCondition_N`/`STEP_N`/`PostCondition_N` entry also gets a short 1-2 line `#` comment
   directly above it** stating in plain language what that step does and why, so a reviewer can
   skim the comments alone and follow the whole test's flow without parsing each
   method/params/`validate_data` block. This is separate from the `validate_data`
   `pass_method`/`fail_method` messages, which are runtime reporting, not code readability.

**The coverage bar (standing rule, every ticket): cover every scenario the ticket actually
specifies or implies, not just the first or easiest one.** A real example: DT-2275 named privacy
mode (0/1/2), ignition status (0/1), and full/partial sessions — six distinct scenarios, split
across five files, not one test that "covers the fix generally." That split — multiple candidate
files, one per scenario-family with genuinely different preconditions/triggers, cross-referenced
in each other's `bug_analysis.json` — is the default whenever scenarios differ enough to warrant it.
Combine into one file with multiple scenario blocks only when they share the same
precondition/fixture and can safely run back-to-back (e.g. testing values 0 then 1 under one
config, one reboot).

**If a scenario needs config changes, a service message, relay hardware, or anything else to
force it into existence — do that. Don't downgrade a real, in-scope scenario to a documented gap
just because forcing it takes real work.** A gap is only honest when NO lever exists anywhere in
the framework after an exhaustive search — confirmed real example: DT-2275's geofence-triggered
privacy mode had zero config key and zero message-injection method anywhere in `Lib/apis/*.py` or
any existing test, checked exhaustively, not glanced at. A config flag, a `SendMsgServer_obj`
message, or a relay call are all buildable, not gaps.

**Mine `nd_test_bot`'s own existing tests before inventing any forcing technique.** Searching
existing tests by keyword before writing anything new is consistently faster and more reliable
than deriving a technique from source alone — real examples: searching surfaced
`SendMsgServer_obj.long_press()` (a no-hardware, TCP-simulated button press) and an existing
test's double-service-restart trick for forcing a session to end early, both reused directly
rather than reinvented. Use a research subagent for this when the search spans multiple keywords
or needs cross-referencing config sections against message handlers.

**If the only blocker to attempting a scenario is needing real device access, just ask for the
device/credentials directly and proceed — don't stop and treat it as a design question.** That's
a resource request, not a decision point; genuine design ambiguity still deserves a real question.

**If something genuinely can't be tested even after that search** (checked the manifest and every
existing test, and there's truly no lever for it — e.g. no way to force an SSID out of a live WiFi
scan), **say so explicitly in `bug_analysis.json` rather than writing a step that can't truthfully
exercise the scenario it claims to.** An honest, documented gap is higher quality than a test that
looks complete but is quietly untestable-as-written — but reach for this only after the exhaustive
search above, not as a first response to something that merely looks hard.

**Mandatory duplicate check, before writing anything — a hard gate, not a suggestion.** Actually
open and read the top `coverage_mapping` candidates (and search the target folder directly by
keyword) — don't stop at whatever score the automated step assigned, in either direction. Then
make an explicit call:
- **An existing test already exercises the same regression** (same fix, same trigger, same oracle
  — not just the same subsystem or shared vocabulary) → **do not generate a new candidate.** Stop,
  and tell the user plainly which test already covers it and why, so they're not left to notice a
  redundant candidate themselves.
- **Existing tests are only adjacent** (same subsystem, different scenario/value/trigger) → proceed
  to generate, and say explicitly which existing tests you checked and why they don't already cover
  this — in your response, not only `bug_analysis.json`.
- **Nothing relevant exists** → proceed to generate, same as always.
A redundant candidate wastes the human reviewer's time and works against the whole point of the
coverage bar above — more tests should mean more real coverage, not more near-duplicates.

**Any device-state change a candidate makes must be reverted by the end of the test — config
files, GPIO/hardware state, service restarts, DB rows, anything, not just config.** Real gap found
this way (DT-4501): `gpio_test -o 0`/`-o 1` are assert/de-assert pairs for a physical camera-reset
line, not momentary pulses — the existing test this candidate's crash-injection technique was
mined from (`TC_1618`) sends `-o 0` to force the crash but never sends `-o 1` afterward, and
nothing in the runtime path recovers the camera either (see `SESSION_LEARNINGS.md` §3.11) — meaning
that existing, currently-used test may leave lab devices with a permanently crashed camera. **Don't
assume an existing test's silence on cleanup means cleanup isn't needed — check what the change
actually does in source, and add an explicit revert `PostCondition` whenever a candidate changes
device state in a way that doesn't self-clear.** `ConsiderPrePost: True` (Step 2 of every candidate
so far) guarantees PostConditions still run even after an early `exit`, so this is always
achievable regardless of where a STEP fails.

**Every candidate must be runnable on every platform — NA, never Fail, where it doesn't apply.**
A testcase lands on whatever device the suite gives it (`krait`, `krait2`, `bagheera`, `bagheera2`,
`bagheera3`, `octo`). A krait-only test must come back **NA** on a bagheera, and a bagheera-only
test **NA** on a krait — a Fail on a device the fix never applied to is a false alarm, and once
people learn to ignore that test's failures it protects nothing.

- **Prefer probing and adapting** over gating out. Most family differences are just a different
  path, unit name or config file for the same behaviour — discover the real one at runtime
  (`for f in /data/nd_files/config/... /home/ubuntu/config/...; do [ -f "$f" ] && ...`, as
  `out/DT-626/TC_4586_*.py` STEP_3 does) and cover both families for real.
- **Gate NA only when the code under test genuinely exists on one family only** — the fix touched
  only `conf/krait/*`, the service isn't installed on the other family, the hardware lever doesn't
  exist there. Shape: `STEP_1` calls `Calculator_obj.get_device_info`
  with `parameters: ["device_type"]` and `save_result: ["device_type"]`, then a `validate_data` whose `condition` is a **positive**
  membership test of the supported families, with `fail_method: {"force_to": "NA",
  "action": "exit"}` and a message naming the family and the reason.
- **The gate goes in `PreCondition_1` (repo convention) or `STEP_1` — either works, but only
  with `{"ConsiderPrePost": "True"}`** as the first `dict_list` entry: `process_dict()` counts
  non-`STEP_` statuses toward the verdict only when it's set, so without it a PreCondition gate
  reports Fail instead of NA. PostConditions run on the NA exit either way. A `"continue to <X>"`
  **jump** from a PreCondition genuinely is discarded — that's a different mechanism. And there is
  no `STEP_0`: the executor starts at the literal `STEP_1`, so a `STEP_0` gate is dead code.
- Write the condition positively (`device_type == "krait" or device_type == "krait2"`), never
  inverted: `get_device_info` returns `None` when the framework couldn't resolve `device_type`, and
  an inverted gate reads that `None` as "must be the other family" and runs anyway.
- **An NA gate may encode family/capability dependency only — never fix presence.** Gating on
  "does the fixed code exist here" makes the test NA on exactly the unfixed builds it exists to
  catch. Judging whether the behaviour is testable at all (a config key the fix introduced being
  absent) is separate, belongs in a later step, and should Fail/exit honestly —
  `out/DT-626/TC_4586_*.py` does both, in STEP_1 and STEP_2 respectively.
- Record in `bug_analysis.json` which families the candidate really covers, which it NAs out on,
  and the evidence for that split.

---

## Step 3 — Validate the candidate (deterministic, no AI)

```bash
python3 out/validate_candidate.py \
    out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py \
    out/_cache/manifest/origin_BI_6.16_20251108.json \
    <SERVICE> origin/BI_6.16_20251108
```

- `<SERVICE>` is the folder name derived from the filename (e.g. `WIFI`, `APM`, `SPEED`) — must
  match an existing folder under `src/test_cases/` on the target branch, or Gate check fails.
- The manifest path is whatever `out/_cache/manifest/<branch-with-slashes-as-underscores>.json`
  Step 1 printed/wrote.

This checks three gates (structure / vocabulary+arity / load) plus filename and test-ID-collision
conventions. **Passing means "not obviously broken," not "correct."** It cannot check whether a
string argument (a service name, a config key) corresponds to anything real on an actual device —
only real hardware execution (Step 6) can do that.

If it fails: fix the specific `FAIL` lines it prints and rerun. Don't proceed past a failing gate.

---

## Step 4 — Human review (mandatory checkpoint — do not skip)

Read the generated `.py` file **and its `bug_analysis.json`** yourself (or have the ticket owner /
a domain reviewer do it) before it touches a real device or `main_db.xlsx`. This tool never
auto-approves anything into the real regression suite — a human decides the candidate is worth
running. If `bug_analysis.json` documents a confidence caveat or a coverage gap, resolve or accept
it explicitly here, not silently later.

Once it passes review and you're going to put it on a device, Step 5 (Jira TC subtask) comes
before Step 6 (deploy) — the filename has to match a real ticket by the time it's registered.

---

## Step 5 — Create the Jira TC subtask (do this as soon as you decide to run it on a device)

```bash
python3 .claude/skills/bug-regression/scripts/create_tc_ticket.py \
    out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py          # --dry-run to look without creating
```

Creates a **Subtask under `TC-4574`** ("Testcases for 6.16 bugs using claude skill", project `TC`)
— the standing parent for everything this pipeline produces — and renames the local candidate to
the id Jira hands back, because **the framework derives a run's Jira key from the testcase
filename**. Use `--parent TC-XXXX` if a candidate belongs under a different story.

Do it *before* Step 6's deploy, not after the run. A `TC_<id>` with no matching Jira ticket makes a
genuinely passing run report as **"Not Executed"**, and an id that happens to belong to somebody
else's ticket attributes your result to unrelated work — both have happened for real.

The script is idempotent: it checks the parent's existing subtasks by summary first and reuses a
match instead of creating a duplicate, so re-running it is always safe. It also records the key in
the candidate's `bug_analysis.json`. If the old id was already deployed or already has a
`main_db.xlsx` row, it stops short of touching either and tells you to clear them and re-run
Step 6 with the renamed file.

Scope, on purpose: it creates exactly one Subtask. It never transitions, resolves, or comments on
any ticket, and never touches the source `DT`/`OCTO` bug ticket.

---

## Step 6 — Deploy + register (automated)

```bash
python3 out/promote_candidate.py out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py --branch <branch>
```

One command, not a manual `cp` plus a manual `openpyxl` snippet. It re-runs `validate_candidate.py`'s
own gates internally first and **refuses to deploy anything that fails them**, refuses to
silently overwrite a file that's already deployed at that path, copies the file into
`repos/nd_test_bot/Test_Automation_Framework/src/test_cases/<SERVICE>/`, and adds the
`main_db.xlsx` row itself. This does not replace Step 4 (human review) — run it only after a
human has actually looked at the candidate.

`main_db.xlsx` has 19 real columns: `file_name, description, time_in_seconds, isChildCase, retry,
Stable, 6.8_Stable, 6.9_Stable, 6.10_Stable, 6.10_OCTO_Stable, 6.11_Stable, 6.12_Stable,
6.14_Stable, 6.16_Stable, 6.12_Bugs, DevPackage_Required, QA_Stable, Remark, Service_name`. The
script fills these using the real conventions verified against ~400 sampled rows (see
`SESSION_LEARNINGS.md §3.9`): `retry`/`isChildCase` left **blank**, not `"No"` (`"No"` breaks a
downstream `int(retry)` call); `Stable`/`<version>_Stable` = `"No"`; `Remark` =
`"candidate, pending review"` — this is what actually marks it as not-yet-approved, not the
Stable columns (`Stable`/`6.16_Stable` aren't even read by a direct `-t TC_id` run, confirmed by
reading `extraction_from_maindb.py`). `description` is pulled automatically from the candidate's
own one-line docstring.

If you need to do this by hand instead (e.g. the script's environment isn't available), the
manual equivalent is a `cp` into the folder above followed by:
```python
import openpyxl
wb = openpyxl.load_workbook("repos/nd_test_bot/Test_Automation_Framework/main_db.xlsx")
ws = wb.active
ws.append(["TC_<id>_....py", "<description>", <time_in_seconds>, None, None,
           "No", None, None, None, None, None, None, None, "No", None, None, None,
           "candidate, pending review", "<SERVICE>"])
wb.save("repos/nd_test_bot/Test_Automation_Framework/main_db.xlsx")
```

---

## Step 7 — Run it on real hardware (mandatory, not optional — this is where a candidate actually becomes trustworthy)

Generating a candidate from the ticket + PR diffs alone gets you roughly 80% of the way there —
real experience across multiple tickets this session confirms that number isn't a guess. The
remaining 20% (wrong service name, a missing precondition check, a shell-quoting bug that only
shows up under this device's actual login shell, a framework control-flow defect) has *never*
been caught by Gate 1/2/3 validation or careful `bug_analysis.json` reasoning alone — only a real device
run has ever caught it, every single time it happened. **A candidate is not done until it has
been run on real hardware — this step is not optional, and "passed static validation" is not a
substitute for it.**

**First, resolve the device's type/IP/username — don't guess, and don't ask a human for it.**

```bash
python3 out/detect_device.py <deviceID>
```

This queries the same MongoDB `ip_db.mycollection` the framework's own `set_env.py` uses,
derives the SSH username from device type (`krait`/`krait2` → `root`;
`bagheera`/`bagheera2`/`bagheera3`/`octo` → `ubuntu`), and pings the IP to report whether it's
directly reachable — all before you ever attempt an SSH connection. Guessing the username wrong
burns a login attempt against a real device; this avoids that. It refuses to guess for an
unrecognized device type rather than pick one arbitrarily — confirm manually in that case. Use
its `reachable_directly` field for the next decision:

### If you're on the company network (device reachable directly)

```bash
export BASE_PATH="$(pwd)/repos/nd_test_bot/Test_Automation_Framework"
cd "$BASE_PATH/src"
python3 main.py -d <deviceID> -t TC_<id>
```

### If you're not on the company network

The device is only reachable via a two-hop SSH path.

1. `ssh dta_server@172.16.23.15` (key-based, no password for this hop).
2. On `dta_server`, find/agree on which `nd_test_bot` checkout to use — there are 25+ on that box;
   **ask which one, don't guess.** Check out the same branch as your local work
   (`git checkout BI_6.16_20251108` — `git stash push -u` first if it refuses due to uncommitted
   work; never force/discard).
3. **Copy your local changes there** — the remote checkout doesn't have them automatically:
   ```bash
   scp out/DT-XXXX/TC_<id>_<SERVICE>_<name>.py \
       dta_server@172.16.23.15:<checkout>/Test_Automation_Framework/src/test_cases/<SERVICE>/
   scp repos/nd_test_bot/Test_Automation_Framework/main_db.xlsx \
       dta_server@172.16.23.15:<checkout>/Test_Automation_Framework/main_db.xlsx
   ```
4. On `dta_server`, check `ss -tlnp | grep 50051` first, then decide `-j` from what you see —
   **don't default to adding it.** `-j`/`--jenkins` means "skip starting your own local GRPC
   server," which only makes sense when another job's server is *already* listening on 50051 for
   you to share. If the port is free, omit `-j` entirely: `main.py` starts its own local server
   and every one of its internal Mongo-wrapper calls (`insert_documents`, `find_documents`,
   `count_documents`, `find_one_document`, used throughout for input/output bookkeeping, device-IP
   lookup, etc.) succeeds immediately against it. Pass `-j` when the port is already occupied by
   someone else's job; passing it when nothing is listening makes *every* one of those calls burn
   through 3 full retries (~3-4 min each, exponential backoff) before falling back to local Mongo
   — confirmed directly: the exact same candidate ran in well under a minute of setup overhead
   without `-j`, versus 25+ minutes of repeated "Timeout while establishing gRPC connection" noise
   with `-j` and no shared server present, before ever reaching `PreCondition_1`.
5. A second SSH hop from `dta_server` to the actual device happens automatically inside the test
   run using the device credentials — you'll be asked for the (rotating) device password.

### Before either path, on a machine you haven't run the framework on recently

Do a real import-chain dry run — `main.py --help` proves top-level imports work but does **not**
catch every missing dependency (it never constructs a `Step` object). See
`SESSION_LEARNINGS.md §5` for the exact snippet if you hit import errors.

### While it's running

- Watch for a real completion marker, not a bare `Traceback` grep (a harmless startup warning
  prints one on every run): `until grep -qE "status_document \{|did not finish in" "$LOG"; do sleep 5; done`
- Once `status_document {...}` appears, the result is durably recorded — you can kill the process
  rather than wait for the (separately flaky) report-download step to finish.

---

## Step 8 — Read the result honestly, and make it genuinely pass — never make it pass

- **Don't trust a `PostCondition` "restored successfully" log line at face value** if the test
  touched device config — independently verify via a direct read-only SSH check (live file
  content + its md5 against the backup dir). A real incident this session showed a restore log
  line lying while the device's self-healing mechanism had already re-corrupted the file.
- **If it fails, diagnose which of three things actually happened before touching anything**:
  (a) a real regression in the code under test, (b) a defect in the generated test itself (wrong
  service name, wrong assumption about device state, a shell-quoting bug specific to this
  device's login shell), or (c) a framework/environment interaction (config self-healing, stale
  SSH cache, GRPC port contention, a PreCondition control-flow defect — see
  `SESSION_LEARNINGS.md §4` item 7). All three have happened for real in this project. Don't
  assume (a) just because the ticket is marked Resolved, and don't assume (b) just because it's a
  generated test.
- If (b): fix the *specific* thing that's actually wrong, re-run Step 3 (validation), then re-run
  Step 6. Document the fix and the reasoning in `bug_analysis.json` (a
  `framework_defects_found_on_real_hardware`-style entry) — this is what happened for real with
  `TC_4127` (added a precondition check), `TC_3961` (`"ndcentral"` → `"bagheera"`), and `TC_3159`
  (a nested-quoting bug that only broke on a busybox-`sh` login shell).
- **Never fix a failure by loosening the assertion, widening a threshold, or removing a check
  just to reach a green run.** The whole point of Step 8 below is that a test which passes no
  matter what isn't testing anything. If you can't find a legitimate reason a failure is wrong,
  it probably isn't wrong — go find the real cause instead of adjusting the oracle.

---

## Step 9 — Confirm it fails without the fix (the other half of "done")

A regression test's entire job is to tell fixed builds apart from unfixed ones. A test that only
gets run against a device that already has the fix has proven it can pass — it has not proven it
would ever catch a real regression. Wherever possible, run the same candidate against a second
device that predates the fix (older firmware, fix not yet integrated) and confirm:

- It fails, and it fails at the step whose oracle actually depends on the fix — not earlier, for
  some unrelated environmental reason. Read the actual failing step, don't just check the overall
  `test_status`.
- The failure reason matches what's expected from reading the pre-fix code path (e.g. "the log
  line this step waits for genuinely doesn't exist in this build" — confirmed for `TC_3159`
  against device `6603052824`, predating DT-525's fix, failing at `STEP_4` exactly as predicted
  from reading the pre-fix source).
- Data/state was independently verified restored on *this* device too — the same backup/restore
  safety net has to hold twice, not once.

**When a genuinely comparable "fix-absent" device isn't available**, say so explicitly in
`bug_analysis.json` as a documented gap rather than silently skipping this step or claiming
full confidence without it — this is the same "raise a concern on thin evidence" principle this
whole tool is built around, just applied to hardware validation instead of Jira evidence.

**A candidate that has (1) run and genuinely passed on a device with the fix, with every failure
along the way root-caused and fixed rather than papered over, and (2) run and correctly failed —
for the right reason — on a device without the fix, is as close to "100%" as this process gets.**
Anything short of both is still a candidate with a known, nameable gap, not a rejected one — name
the gap in `bug_analysis.json`'s `device_validation` section rather than overstating confidence.

---

## Step 10 — Final sign-off

The candidate stays `Remark = "candidate, pending review"` in `main_db.xlsx` until a human
explicitly promotes it. This tool never does that automatically, never files a Jira ticket, and
never commits/pushes anything — every one of those remains a deliberate human action, on purpose.
