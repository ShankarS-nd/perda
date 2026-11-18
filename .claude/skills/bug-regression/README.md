# `bug-regression` skill

A self-contained, installable Claude Code skill that turns a Netradyne Jira bug ticket (`DT` or
`OCTO` project) into a validated `nd_test_bot` regression test — deterministic Jira/GitHub
research, PR-diff-grounded AI bug analysis, candidate test generation, static validation, and
real-device validation on both a fixed and an unfixed device.

Everything one conversation learned building and using this process — including two real
framework/environment bugs found only by running on real hardware — is written into `SKILL.md` so
a fresh Claude session performs at the same quality bar without re-discovering it the hard way.

## What's in this folder

```
bug-regression/
├── SKILL.md              <- the actual skill instructions, loaded when invoked
├── README.md             <- this file (install instructions, not loaded by the skill itself)
├── requirements.txt      <- Python deps the bundled scripts (and nd_test_bot) need
├── scripts/
│   ├── bugreg_research.py    deterministic evidence gathering (Jira, git, PR diffs, DSL manifest)
│   ├── validate_candidate.py 3-gate static validator (structure / vocabulary / load)
│   ├── detect_device.py      deviceID -> device type / IP / SSH user, from the framework's Mongo
│   ├── create_tc_ticket.py   creates the candidate's Jira TC subtask under TC-4574 and renames
│   │                         the file to match the key it gets back (run before any device run)
│   └── promote_candidate.py  deploys a validated candidate + registers it in main_db.xlsx
└── docs/
    ├── HOW_THE_TOOL_WORKS.md   the pipeline explained in plain language
    ├── USAGE_GUIDE.md          the same process as a standalone step-by-step runbook
    └── SESSION_LEARNINGS.md    the full catalogue of framework defects and tactics
```

## Before you can run anything: this skill needs a real project set up

**This is the part installing the skill/plugin does NOT do for you.** The skill is just
instructions + scripts — it has no bundled Jira access, no bundled copy of Netradyne's repos, and
no bundled Python environment. If you point it at an empty folder, it will now (as of v1.0.1) stop
and tell you what's missing rather than silently searching your machine for someone else's existing
checkout to borrow — so you need to actually do this setup yourself, once, per project root you
intend to run it from:

| # | What | How |
|---|------|-----|
| 1 | **Jira credentials** | Create a `.env` file at your project root with `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (your own personal Jira API token — https://id.atlassian.com/manage-profile/security/api-tokens), and `JIRA_AUTH_MODE=cloud`. |
| 2 | **The repos it reads fixes from** | `mkdir repos && cd repos`, then `git clone git@github.com:netradyne/nd_device_services.git`, `nd_core_utils.git`, and `nd_test_bot.git`. SSH access to GitHub is usually enough even without a GitHub API token — check with `ssh -o BatchMode=yes git@github.com`. If a specific ticket's fix lives in a different repo (e.g. `shield`), clone that one too when the skill tells you it's missing. |
| 3 | **A Python environment** | `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt` (this repo's `requirements.txt`, not `nd_test_bot`'s pinned one — see the comments in that file for why). Also make sure `mongod` is running/reachable, since `nd_test_bot`'s own device lookups depend on it. |

Once all three exist at your project root, `cd` into that project and invoke the skill from there
(or pass `--project-root <path>` / set `$BUGREG_PROJECT_ROOT` if you're invoking it from elsewhere).

## Installing on a new system / project

### Option A — as a Claude Code plugin (recommended)

This repo is both a plugin and its own marketplace. One-time setup per teammate:

```
claude plugin marketplace add <git-host>/nd-bug-regression-plugin
claude plugin install bug-regression@nd-bug-regression-marketplace
```

Updates: whoever maintains the repo pushes a new commit (bump `version` in
`.claude-plugin/plugin.json` for clarity); teammates run `claude plugin update bug-regression`.

### Option B — plain copy (no plugin involved)

1. Copy this whole folder to wherever Claude Code looks for skills:
   - **Project-scoped** (recommended if you want it committed alongside a specific `nd_test_bot`
     checkout so anyone who clones that repo gets it too): `<project>/.claude/skills/bug-regression/`
   - **User-scoped** (available in every project on this machine): `~/.claude/skills/bug-regression/`

2. In the target project's root, do the one-time setup described above (`.env`, `repos/`,
   Python env).

3. Invoke it from within that project: `/bug-regression DT-1234` (or whatever your Claude Code
   client's convention is for this skill's name — see `SKILL.md`'s frontmatter).

That's it — no build step, no separate service. The bundled scripts figure out the project root
themselves (`--project-root` flag → `$BUGREG_PROJECT_ROOT` env var → current working directory),
so this same folder works unmodified whether it's the user-level copy invoked from any project or
a project-level copy committed into a specific repo.

## Updating this skill after it's installed elsewhere

This bundle has no external dependencies on the repo it was built in — it's just files. To update
an installed copy, replace the folder wholesale, or `git pull` if you've put it under version
control alongside the target project's own `.claude/` directory.

## Scope note

This is **not** a generic "any bug tracker to any test framework" tool — it's built specifically
around Netradyne's Jira (confirmed working for the `DT` and `OCTO` projects — both fix code in the
same repos and get tested via the same `nd_test_bot` DSL, so nothing about the pipeline differs
between them beyond Jira's own per-project custom field naming, which is handled automatically),
GitHub org (`netradyne`), and `nd_test_bot`'s own DSL and `main_db.xlsx` conventions. "Any system"
means any machine/repo where that same environment is available, not an arbitrary bug tracker or
test framework. A ticket from an unrelated Jira project (a different product/codebase entirely)
will still fetch, but the fix-location search, component inference, and coverage-mapping are all
tied to this specific device-automation domain — see `SESSION_LEARNINGS.md` and the tool's own
answers on this topic for what degrades gracefully vs. what doesn't.
