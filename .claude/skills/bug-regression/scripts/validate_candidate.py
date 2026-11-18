#!/usr/bin/env python3
"""
Prototype of bug_regression/framework/validator.py

Three gates a generated candidate must pass before a human is asked to review it:

  GATE 1  structure   -- the dict_list conforms to the interpreter's step grammar
  GATE 2  vocabulary  -- every method resolves to a real object/method on the target
                         branch, with a compatible arity
  GATE 3  load        -- the file imports and exposes dict_list, using the exact
                         mechanism the framework itself uses
                         (test_cases_helper.load_dict_from_test_case_file)

Plus two convention checks that the executor depends on:
  filename convention  -- TC_<id>_<SERVICEFOLDER>_<NAME>.py, since
                          Lib/Initialiser_api/execution.py derives the folder from the FILENAME
  id collision         -- the numeric id must be free on the target branch

Usage: validate_candidate.py <candidate.py> <manifest.json> <service_folder> [branch] [--repo <path>]

<repo> defaults to $BUGREG_PROJECT_ROOT/repos/nd_test_bot, or ./repos/nd_test_bot if that env
var isn't set -- i.e. run this from your project root, or pass --repo explicitly. Do not rely
on this script's own file location, which is not portable across installs.
"""
import argparse
import ast
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_REPO = Path(os.environ.get("BUGREG_PROJECT_ROOT", ".")).resolve() / "repos" / "nd_test_bot"
REPO = DEFAULT_REPO

STEP_KEYS = {
    "method", "wait_method", "parameters", "save_result", "save_status", "save_data",
    "validate_data", "loop", "sleep", "Run_Test", "trigger", "reporting", "increment",
    "combine", "force_to", "log_analyser",
}
STEP_NAME_RE = re.compile(r"^(PreCondition|PostCondition)?_?(STEP)?_?\d+$|^(Pre|Post)Condition_STEP_\d+$")
ACTIONS = {"continue", "exit"}


class Result:
    def __init__(self):
        self.errors, self.warnings, self.info = [], [], []

    def err(self, g, m):
        self.errors.append(f"[{g}] {m}")

    def warn(self, g, m):
        self.warnings.append(f"[{g}] {m}")

    def note(self, m):
        self.info.append(m)


def load_dict_list(path):
    """Gate 3: exactly what Lib/Initialiser_api/test_cases_helper.py does."""
    spec = importlib.util.spec_from_file_location("candidate.module", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.dict_list


def valid_step_name(name):
    if name in ("ConsiderPrePost",):
        return True
    return bool(
        re.match(r"^STEP_\d+(_\d+)?$", name)          # STEP_5, STEP_4_1 (sub-step, e.g. TC_2941)
        or re.match(r"^PreCondition_\d+$", name)
        or re.match(r"^PostCondition_\d+$", name)
        or re.match(r"^PreCondition_STEP_\d+(_\d+)?$", name)
        or re.match(r"^PostCondition_STEP_\d+(_\d+)?$", name)
    )


def check_structure(dict_list, r):
    if not isinstance(dict_list, list):
        r.err("GATE1", "dict_list is not a list")
        return
    saw_step1 = False
    for i, entry in enumerate(dict_list):
        if not isinstance(entry, dict):
            r.err("GATE1", f"entry {i} is {type(entry).__name__}, expected dict")
            continue
        for name, content in entry.items():
            if name in ("ConsiderPrePost", "trigger"):
                continue
            if not valid_step_name(name):
                r.err("GATE1", f"invalid step name {name!r}")
                continue
            if name == "STEP_1":
                saw_step1 = True
            if not isinstance(content, dict):
                r.err("GATE1", f"{name}: content must be a dict")
                continue
            for k in content:
                if k not in STEP_KEYS:
                    r.err("GATE1", f"{name}: unknown step key {k!r}")
            if "method" not in content and "wait_method" not in content \
                    and "Run_Test" not in content and "validate_data" not in content:
                r.err("GATE1", f"{name}: step has no method/wait_method/Run_Test/validate_data")
            for vd in content.get("validate_data", []) or []:
                if "condition" not in vd and "conditions" not in vd:
                    r.err("GATE1", f"{name}: validate_data entry has no condition")
                    continue
                if "condition" in vd:
                    for branch in ("pass_method", "fail_method"):
                        if branch not in vd:
                            r.err("GATE1", f"{name}: validate_data missing {branch}")
                            continue
                        act = vd[branch].get("action")
                        if act is not None and act not in ACTIONS and not act.startswith("goto"):
                            r.warn("GATE1", f"{name}.{branch}: unusual action {act!r} "
                                            "(interpreter will treat it as a jump target)")
                    # eval() runs with __builtins__=None -- reject builtin use up front
                    cond = vd["condition"]
                    for bad in ("int(", "str(", "len(", "float(", "print("):
                        if bad in cond:
                            r.err("GATE1", f"{name}: condition uses builtin {bad!r} but the "
                                           "interpreter evaluates conditions with __builtins__=None")
    if not saw_step1:
        r.err("GATE1", "no STEP_1 - Workflow.execute() starts at 'STEP_1' and would raise")


def check_vocabulary(dict_list, manifest, r):
    for entry in dict_list:
        if not isinstance(entry, dict):
            continue
        for name, content in entry.items():
            if not isinstance(content, dict):
                continue
            params = content.get("parameters", []) or []
            for key in ("method", "wait_method"):
                ref = content.get(key)
                if not ref or not isinstance(ref, str):
                    continue
                if "." not in ref:
                    r.err("GATE2", f"{name}: malformed method reference {ref!r}")
                    continue
                obj, meth = ref.split(".", 1)
                if obj not in manifest:
                    r.err("GATE2", f"{name}: object {obj!r} is not in the registry on this branch")
                    continue
                if meth not in manifest[obj]["methods"]:
                    r.err("GATE2", f"{name}: {obj}.{meth} does not exist "
                                   f"({manifest[obj]['class']} has no such method)")
                    continue
                sig = manifest[obj]["methods"][meth]["sig"]
                required = len([s for s in sig if "=" not in s and not s.startswith("*")])
                total = len(sig)
                variadic = any(s.startswith("*") for s in sig)
                if key == "wait_method":
                    if len(params) < 4:
                        r.err("GATE2", f"{name}: wait_method needs at least "
                                       "[object_method, desired_value, expiry, sleep]")
                        continue
                    if params[0] != ref:
                        r.err("GATE2", f"{name}: wait_method parameters[0] must repeat "
                                       f"{ref!r} (got {params[0]!r}); the interpreter calls "
                                       "wait_for_condition(*params)")
                    call_args = params[4:]
                else:
                    call_args = params
                n = len(call_args)
                if n < required:
                    r.err("GATE2", f"{name}: {obj}.{meth} needs >={required} args, got {n} "
                                   f"-- signature ({', '.join(sig)})")
                elif n > total and not variadic:
                    r.err("GATE2", f"{name}: {obj}.{meth} accepts <={total} args, got {n} "
                                   f"-- signature ({', '.join(sig)})")
                else:
                    r.note(f"  ok  {name:20} {ref}({n} args)  [{manifest[obj]['methods'][meth]['file']}]")


def check_conventions(path, service_folder, branch, r):
    fn = Path(path).name
    m = re.match(r"^TC_(\d+)_([A-Z0-9-]+)_", fn)
    if not m:
        r.err("CONV", f"filename {fn!r} does not match TC_<id>_<SERVICE>_<NAME>.py")
        return
    tc_id, svc = m.group(1), m.group(2)
    # execution.py: re.split('_|-', filename, maxsplit=1)[1].split('_')[1]
    derived = re.split(r"_|-", fn, maxsplit=1)[1].split("_")[1]
    if derived != service_folder:
        r.err("CONV", f"executor would look in src/test_cases/{derived}/ but the target "
                      f"folder is {service_folder}/")
    else:
        r.note(f"  ok  executor resolves folder -> src/test_cases/{derived}/")
    if branch:
        out = subprocess.run(
            ["git", "-C", str(REPO), "ls-tree", "-r", "--name-only", branch],
            capture_output=True, text=True).stdout
        if re.search(rf"/TC_{tc_id}_", out):
            r.err("CONV", f"test id TC_{tc_id} already exists on {branch}")
        else:
            r.note(f"  ok  test id TC_{tc_id} is free on {branch}")
        if f"/{service_folder}/" not in out:
            r.err("CONV", f"service folder {service_folder}/ does not exist on {branch}")
        else:
            r.note(f"  ok  service folder {service_folder}/ exists on {branch}")


def run_gates(path, manifest_path, service_folder, branch, repo=None):
    """Run all three gates + convention checks, return the Result object. Importable directly
    (e.g. by promote_candidate.py) so callers get a real Result to inspect, not just an exit
    code from a subprocess."""
    global REPO
    if repo:
        REPO = Path(repo).resolve()

    manifest = json.load(open(manifest_path))
    r = Result()

    print(f"Validating {Path(path).name}")
    print(f"  manifest : {len(manifest)} objects, "
          f"{sum(len(v['methods']) for v in manifest.values())} methods")
    print(f"  branch   : {branch}\n")

    # GATE 3 first: if it will not load, nothing else is meaningful
    try:
        dict_list = load_dict_list(path)
        r.note(f"  ok  module loaded, dict_list has {len(dict_list)} entries")
    except Exception as e:
        r.err("GATE3", f"failed to load: {type(e).__name__}: {e}")
        dict_list = None

    if dict_list is not None:
        check_structure(dict_list, r)
        check_vocabulary(dict_list, manifest, r)
    check_conventions(path, service_folder, branch, r)
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("manifest_path")
    ap.add_argument("service_folder")
    ap.add_argument("branch", nargs="?", default=None)
    ap.add_argument("--repo", default=None, help=f"default: {DEFAULT_REPO}")
    args = ap.parse_args()

    r = run_gates(args.path, args.manifest_path, args.service_folder, args.branch, args.repo)

    for line in r.info:
        print(line)
    print()
    for w in r.warnings:
        print(f"WARN  {w}")
    for e in r.errors:
        print(f"FAIL  {e}")
    print()
    if r.errors:
        print(f"RESULT: REJECTED ({len(r.errors)} error(s), {len(r.warnings)} warning(s))")
        return 1
    print(f"RESULT: PASSED all gates ({len(r.warnings)} warning(s)) -> ready for human review")
    return 0


if __name__ == "__main__":
    sys.exit(main())
