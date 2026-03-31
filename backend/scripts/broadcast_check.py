"""
broadcast_check.py — Broadcast listener.

Listens for UDP broadcasts on port 12345 and reports which devices
from the given list were seen within the timeout window.

Pass logic:
  PASS         → all devices found broadcasting
  PARTIAL_PASS → at least one device found, some missing
  FAIL         → no devices found at all

Exits early if all devices are found before timeout.
Outputs structured JSON for workflow integration.
"""

import argparse
import socket
import json
import sys
import time

# ---------------------------------------------------------------------------
# Argument metadata — consumed by the dashboard for dynamic form rendering.
# ---------------------------------------------------------------------------
SCRIPT_ARGS = [
    {"name": "device_list", "type": "string", "description": "Comma-separated device IDs to listen for"},
    {"name": "timeout",     "type": "int",    "description": "How many seconds to listen for broadcasts", "default": "120"},
]


def start_broadcast_listener(device_list, timeout=120):
    device_data = {}
    devices_set = set(device_list)
    start_time = time.time()

    print(f"\nListening for broadcasts for up to {timeout} seconds...")
    print(f"Looking for {len(device_list)} device(s): {', '.join(device_list)}\n")

    client_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    client_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    client_socket.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    client_socket.bind(('', 12345))
    client_socket.settimeout(2)

    while time.time() - start_time < timeout:
        try:
            data, address = client_socket.recvfrom(1024)
            d = json.loads(data.decode())
            device_id = d.get("deviceId")

            if device_id in devices_set:
                if device_id not in device_data:
                    elapsed = round(time.time() - start_time, 1)
                    print(f"✅ [{elapsed}s] Broadcast received from {device_id} at {address[0]}")

                device_data[device_id] = address[0]

                # Early exit: all devices found — no need to wait for timeout
                if set(device_data.keys()) == devices_set:
                    elapsed = round(time.time() - start_time, 1)
                    print(f"\n🎉 All {len(device_list)} devices found in {elapsed}s — stopping early!")
                    break

        except socket.timeout:
            continue
        except Exception as e:
            print("Error decoding packet:", e)
            continue

    client_socket.close()

    elapsed = round(time.time() - start_time, 1)
    found = sorted(device_data.keys())
    missing = sorted(devices_set - set(device_data.keys()))

    # ---- Pretty summary ----
    print(f"\n{'='*50}")
    print(f"BROADCAST CHECK RESULTS (after {elapsed}s)")
    print(f"{'='*50}")
    print(f"  Total devices:  {len(device_list)}")
    print(f"  Found:          {len(found)}")
    print(f"  Missing:        {len(missing)}")

    if found:
        print(f"\n  ✅ Broadcasting:")
        for d in found:
            print(f"     • {d} ({device_data[d]})")

    if missing:
        print(f"\n  ❌ NOT Broadcasting:")
        for d in missing:
            print(f"     • {d}")

    # Determine status
    if len(found) == len(device_list):
        status = "pass"
        print(f"\n  STATUS: ✅ PASS — All devices broadcasting")
    elif len(found) > 0:
        status = "partial_pass"
        print(f"\n  STATUS: ⚠️  PARTIAL PASS — {len(found)}/{len(device_list)} devices broadcasting")
    else:
        status = "fail"
        print(f"\n  STATUS: ❌ FAIL — No devices broadcasting")

    print(f"{'='*50}")

    # ---- Structured JSON output (parsed by workflow engine) ----
    result = {
        "status": status,
        "found": ",".join(found),
        "missing": ",".join(missing),
        "found_count": len(found),
        "missing_count": len(missing),
        "total_count": len(device_list),
        "device_list": ",".join(device_list),
        "elapsed_seconds": elapsed,
    }
    print(json.dumps(result))

    return found, missing, status


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Broadcast listener")
    parser.add_argument("--device_list", type=str, required=True, help="Comma-separated device IDs")
    parser.add_argument("--timeout", type=int, default=120, help="Seconds to listen")
    args = parser.parse_args()

    devices = [d.strip() for d in args.device_list.split(",") if d.strip()]
    found, missing, status = start_broadcast_listener(devices, args.timeout)

    # Exit 0 if at least one device found (partial pass or full pass)
    # Exit 1 only if zero devices were found
    sys.exit(0 if status in ("pass", "partial_pass") else 1)
