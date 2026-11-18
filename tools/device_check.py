#!/usr/bin/env python3
"""Run a few READ-ONLY commands on a device and print what they returned, as JSON.

Used by tc_worker.py before a validation: it is how the dashboard learns whether a device has the
fix. Run with the project's .venv python (it has paramiko). The request is JSON on stdin:
  {"host": "...", "user": "...", "commands": ["cat /etc/hostname", ...]}
The password is in the environment variable BUGREG_CHECK_PASSWORD, never on the command line.
Output: {"results": [{"rc": 0, "out": "..."}, ...]} or {"error": "login"|"connect", "detail": "..."}.
"""
import json
import os
import sys


def main() -> int:
    try:
        import paramiko
    except ImportError:
        print(json.dumps({"error": "connect", "detail": "paramiko is not installed in this python"}))
        return 0
    req = json.loads(sys.stdin.read())
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())   # a CHANGED key still raises
    try:
        client.connect(req["host"], username=req["user"], password=os.environ.get("BUGREG_CHECK_PASSWORD", ""),
                       timeout=10, banner_timeout=15, auth_timeout=15, allow_agent=False, look_for_keys=False)
    except paramiko.AuthenticationException:
        print(json.dumps({"error": "login", "detail": "the password was not accepted"}))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": "connect", "detail": f"{type(exc).__name__}: {exc}"[:300]}))
        return 0
    results = []
    try:
        for cmd in req.get("commands", []):
            try:
                _, stdout, stderr = client.exec_command(cmd, timeout=20)
                out = stdout.read(20000).decode(errors="replace")
                rc = stdout.channel.recv_exit_status()
                results.append({"rc": rc, "out": out[:4000]})
            except Exception as exc:  # noqa: BLE001
                results.append({"rc": 255, "out": "", "error": f"{type(exc).__name__}: {exc}"[:200]})
    finally:
        client.close()
    print(json.dumps({"results": results}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
