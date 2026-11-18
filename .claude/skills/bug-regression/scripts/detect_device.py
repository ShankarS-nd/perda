#!/usr/bin/env python3
"""
detect_device.py -- resolve a device's type/IP/SSH-username without guessing or blindly SSHing
in first.

Mirrors exactly what nd_test_bot's own Lib/Initialiser_api/set_env.py does before it ever opens
an SSH connection: look the device up in MongoDB's ip_db.mycollection, keyed by deviceID. This
requires the same local mongod the framework itself needs to run at all (see
docs/SESSION_LEARNINGS.md §8) -- if that's not reachable, this can't resolve anything either,
same as the framework.

Usage:
  python3 detect_device.py <device_id>

Prints one line of JSON:
  {"device_id", "device_type", "device_ip", "ssh_username", "reachable_directly"}

ssh_username is derived from device_type using the exact same mapping as set_env.py:
  krait / krait2                          -> root
  bagheera / bagheera2 / bagheera3 / octo -> ubuntu
An unrecognized device_type prints a warning to stderr and leaves ssh_username null rather than
guessing -- confirm manually in that case (deviceconfig.ini on the device, or ask a human).

reachable_directly is a plain ping check -- if it's false, expect a jump-host hop is needed
(see docs/USAGE_GUIDE.md Step 7) rather than assuming the SSH username/IP found here are wrong.
"""
import json
import subprocess
import sys

try:
    from pymongo import MongoClient
except ImportError:
    print(json.dumps({"error": "pymongo not importable -- run this with the project venv's "
                                "python3 (e.g. .venv/bin/python3), not the system one"}))
    sys.exit(1)

KRAIT_TYPES = {"krait", "krait2"}
UBUNTU_TYPES = {"bagheera", "bagheera2", "bagheera3", "octo"}


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 detect_device.py <device_id>", file=sys.stderr)
        sys.exit(1)
    device_id = sys.argv[1]

    try:
        client = MongoClient("localhost", 27017, serverSelectionTimeoutMS=5000)
        doc = client["ip_db"]["mycollection"].find_one({"deviceID": device_id})
    except Exception as e:
        print(json.dumps({"error": f"could not query local mongod: {type(e).__name__}: {e} -- "
                                    f"is mongod running? (systemctl status mongod)"}))
        sys.exit(1)

    if not doc:
        print(json.dumps({"error": f"device {device_id!r} not found in ip_db.mycollection -- "
                                    f"check the ID, or this framework instance's Mongo isn't "
                                    f"the one that knows about this device"}))
        sys.exit(1)

    device_type = doc.get("deviceType")
    device_ip = doc.get("deviceIP")

    if device_type in KRAIT_TYPES:
        username = "root"
    elif device_type in UBUNTU_TYPES:
        username = "ubuntu"
    else:
        username = None

    reachable = False
    if device_ip:
        r = subprocess.run(["ping", "-c", "2", "-W", "3", device_ip],
                            capture_output=True, timeout=10)
        reachable = r.returncode == 0

    print(json.dumps({
        "device_id": device_id,
        "device_type": device_type,
        "device_ip": device_ip,
        "ssh_username": username,
        "reachable_directly": reachable,
    }, indent=2))

    if username is None:
        print(f"WARNING: unrecognized device_type {device_type!r} -- known krait-family types "
              f"map to username 'root', known bagheera/octo-family types map to 'ubuntu'. "
              f"Don't guess for this one -- confirm manually (deviceconfig.ini on the device, "
              f"or ask a human) before attempting SSH.", file=sys.stderr)


if __name__ == "__main__":
    main()
