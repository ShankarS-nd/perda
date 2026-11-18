# How the Bug-to-Regression Tool Works — Plain-Language Guide

**Audience:** anyone who needs to understand this tool without reading the code.
**Companion doc:** `docs/BUG_REGRESSION_ARCHITECTURE.md` (the formal architecture analysis).
**Last updated:** 2026-08-10, after the first real-device validation run (DT-3961 / device 264065431).

---

## 1. The problem, in one paragraph

A Jira bug ticket has a story buried inside it: what broke, why, and how it was fixed. The
test-automation repo (`nd_test_bot`) has its own fixed vocabulary of things it knows how to do —
reboot a device, check whether a service is running, search a log file for a specific line. This
tool's job is to **read the ticket's story, translate it into that vocabulary, and write a test
file** that will catch the bug if it ever comes back. Then it double-checks the test is at least
*plausible* before anyone runs it on real hardware.

There are exactly **two kinds of work**, and keeping them separate is the whole design:

- **Code work** — fetching the ticket, searching git history, reading log files, checking that a
  method name is spelled correctly. Done by a Python script. Fast, repeatable, never guesses.
- **Understanding work** — figuring out *what the bug actually means* and *what a good test
  should check*. Done by the AI, reading what the script found and reasoning about it.

---

## 2. The two scripts

### `out/bugreg_research.py` — "go gather everything needed to understand this bug"

Run it like this:

```bash
python3 out/bugreg_research.py DT-3961 --branch BI_6.16_20251108
```

It does six jobs, in order, and never writes a test itself — it only collects facts:

1. **Fetch the ticket from Jira** — summary, description, root cause, resolution, comments,
   linked issues.
2. **Find the actual code fix in git** — searches every branch and commit message in the device
   repos for the ticket number, so it can point at the *real* commit that fixed the bug instead
   of guessing.
3. **Pull candidate "oracle" log lines** — reads the changed source file and extracts any
   `LOG_*(...)` lines that look relevant, ranked by wording overlap with the bug's own text. ("Oracle"
   = the specific log line a test can search for to know whether the bug happened.)
4. **Build the capability manifest** — reads the test framework's own code and lists every method
   a test is *allowed* to call, so a generated test can never invent something that doesn't exist.
5. **Load the test registry** — reads `main_db.xlsx`, the framework's spreadsheet of 1,700+
   existing tests, so it knows what's already covered.
6. **Guess the component, and rank existing tests against it** — tries to work out "is this a
   WIFI bug? an APM bug?", then scores existing tests by how similar their description is to the
   bug.

Everything it finds goes into one file: `out/<TICKET>/research_bundle.json` (plus a readable
`.md` copy). It does **not** decide what the test should say — that's the AI step, reading the
bundle afterward.

### `out/validate_candidate.py` — "check this generated test isn't obviously broken"

Run it like this:

```bash
python3 out/validate_candidate.py out/DT-3961/TC_3961_....py out/_cache/manifest/....json SPEED origin/BI_6.16_20251108
```

It checks a generated test against three "gates," plus two naming rules:

- **Gate 1 — structure**: is the file shaped correctly (right keys, has a starting step, etc.)?
- **Gate 2 — vocabulary**: does every method the test calls actually exist, with the right
  number of arguments?
- **Gate 3 — load**: does the file actually import in Python without crashing?
- **Filename rule**: does the filename match the folder it lives in? (The real executor derives
  the folder from the filename, not the path — a mismatch means the test is invisible to it.)
- **ID rule**: is the numeric test ID actually free, not already used by another test?

**What it cannot check**, and this is a permanent limitation, not a bug to fix: it cannot tell
whether a *string argument* is correct. `"ndcentral"` is a perfectly valid string to pass to
`service_status([...])` — the validator has no way to know it isn't a real service name unless it
can ask the actual device. That gap is exactly what real hardware execution is for.

---

## 3. Every file the tool produces

Using `DT-3961` as the example, here's what lands in `out/DT-3961/` and why:

| File | What it is | In plain words |
|---|---|---|
| `research_bundle.json` / `.md` | Raw facts, gathered by code | "Here's everything found about this ticket, without thinking about it" |
| `bug_analysis.json` | The AI's understanding of the bug | "Here's what actually went wrong, and how sure I am" |
| `coverage_mapping.json` | The AI's check for existing coverage | "Here's whether an existing test already covers this, and why or why not" |
| `TC_<id>_..._<name>.py` | The generated test itself | The test file, written in the framework's own language |
| `execution_<n>_failure_analysis.json` | What happened on a real run | "Here's what the device actually did, and what it means" (only exists after a real execution) |

And the shared, cross-ticket cache in `out/_cache/` (never re-fetched once built):

| File | What it is |
|---|---|
| `jira/<TICKET>.json` | The raw Jira response, saved once so the same question is never re-asked |
| `manifest/<branch>.json` | Every method the test framework allows, for a given branch |
| `registry/<branch>.json` | The 1,700+ existing tests read out of `main_db.xlsx` |

---

## 4. The full flow, step by step (as it actually happened for DT-3961)

1. **A ticket ID comes in.** `DT-3961`.
2. **Run the research script.** `bugreg_research.py DT-3961 --branch BI_6.16_20251108`. It
   fetches the ticket, finds the fixing commit (`b0b9c4fe6`), pulls candidate log lines, builds/
   reuses the manifest and registry, guesses a component. Writes `research_bundle.json`.
3. **The AI reads the bundle and reasons about it.** For DT-3961 the script's own component guess
   came back empty ("no confident component") — so the AI read the raw Jira *comments* directly
   and found the real story: a service-startup-timing bug, fixed by reverting a shell-script-to-
   binary change. That understanding goes into `bug_analysis.json`.
4. **Check whether an existing test already covers it.** Not by trusting a similarity score —
   by actually opening the top-scoring existing tests and reading them. For DT-3961, `TC_2941`
   looked close but tested something different once read. Written into `coverage_mapping.json`.
5. **Write the actual test**, using only methods from the manifest and log lines taken word-for-
   word from real source code or real Jira comments — never invented.
6. **Validate it.** Run `validate_candidate.py`. Passing only proves "not obviously broken," not
   "correct."
7. **Run it on a real device.** This is where the gates' limits showed up: it failed, and the
   failure traced back to `"ndcentral"` not being a real service name — something no amount of
   static checking could have caught.
8. **Fix and re-validate.** `"ndcentral"` → `"bagheera"`, re-run `validate_candidate.py`, re-run
   on the device.
9. **The real run then found something else** — a genuine, currently-existing race condition
   between two services at boot, unrelated to the original ticket. Written up as a draft in
   `execution_1_failure_analysis.json`, explicitly not filed anywhere.

---

## 5. The one distinction that matters most

Step 2 (the script) is **deterministic** — same ticket, same branch, same answer, every time,
cheap to re-run. Steps 3–5 (the AI reading and writing) are **judgment** — this is where a
*different kind of ticket* actually behaves differently. A ticket with no linked commit, a
garbled description, or a totally different bug category doesn't break the script — it just
gives the script less to work with, which changes how much weight falls on reasoning instead of
hard evidence. That boundary is the thing to watch when extending this tool to handle more kinds
of tickets.

---

## 6. Known limitations, confirmed by real use (not hypothetical)

- **String arguments aren't checked against reality.** (`"ndcentral"` vs `"bagheera"` — see
  above.) Fix direction: cross-reference `service_status(...)` arguments against a real systemd
  unit list per platform, the same way method names are already cross-referenced against the
  manifest.
- **`bug.comments` are fetched but not fed into the component-inference step.** DT-3961's real
  component only surfaced from the comments; the script's own summary/description-only guess came
  back empty. Comments should be a third-tier signal, below labels, above the weak-token fallback.
- **`main_db.xlsx` field conventions must be read from real data, not guessed.** Two guesses were
  wrong on the first attempt (`retry` and `isChildCase` should be left blank in almost every real
  row — `"No"` is not the convention and broke a downstream code path that tries to parse `retry`
  as a number).
- **The framework already has its own Jira integration** (`jira_info.py`, called from
  `Interface/report_generation.py`), discovered mid-session. It looks up a test's numeric ID as a
  `TC-<n>` Jira reference. This was missed in the original Phase 1 architecture analysis and
  should be reconciled with — not duplicated by — this tool.
- **Environment setup for running the framework locally has real gotchas**: `numpy==1.24.4` (in
  `requirements.txt`) has no Python 3.12 wheel and needs the removed `distutils` to build from
  source — install a modern unpinned version instead, or skip it if only running tests via CLI
  (it's only needed for PDF/report generation). The `-j` (`--jenkins`) flag skips starting the
  GRPC server, but Mongo access still routes through it — every Mongo-touching step then eats a
  ~60s timeout before falling back to a local method. Running *without* `-j` avoids this. The
  post-run Flask report-download step has its own, separate hang that isn't fixed by either
  choice — if the actual test result has already appeared in the log, it's safe to stop waiting
  for the report step to finish.
