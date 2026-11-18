<!--
PROPOSED change to .claude/skills/bug-regression/SKILL.md. NOT applied (Claude may not edit the
skill's own instructions, so paste it by hand). Delete this comment when pasting.

In section 12, stage `generate`, REPLACE the three outcome bullets
("Candidates written and passing ...", "The mandatory duplicate check ...", "Anything else ...")
with the four bullets below. Nothing else changes: the backend and worker already accept the
new outcome, so until this is pasted Claude simply never reports it.
-->

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
