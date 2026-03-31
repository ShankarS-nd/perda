"""
keepalive_check.py — Check device keepalive status via ops-data API.

Queries the Netradyne staging API to determine if devices are alive
based on their keepAlive timestamp.

Pass logic:
  PASS         → all devices alive
  PARTIAL_PASS → at least one device alive, some not
  FAIL         → no devices alive at all

Outputs structured JSON for workflow integration.
"""

import argparse
import json
import time
import sys
import requests
from datetime import datetime, timezone, timedelta
from typing import Literal

# ---------------------------------------------------------------------------
# Argument metadata — consumed by the dashboard for dynamic form rendering.
# ---------------------------------------------------------------------------
SCRIPT_ARGS = [
    {"name": "device_ids", "type": "string", "description": "Comma-separated device IDs to check keepalive status"},
    {"name": "threshold", "type": "int",    "description": "Minutes threshold to consider device alive", "default": "12"},
]

AUTH_TOKEN_URL = "https://auth-staging.netradyne.com/authserver/api/v1/oauth/token"
AUTH_SESSION_URL = "https://auth-staging.netradyne.com/authserver/api/v1/session"
OPS_DATA_URL = "https://idms-staging.netradyne.com/device-health/api/v1/opsdashboard/ops-data"

CLIENT_ID = "idms"
GRANT_TYPE = "password"
USERNAME = "device-test-automation"
PASSWORD = "devicetestautomation"

PRODUCT_IDS_TO_TRY = [2, 11, 12, 9, 14, 15, 16, 13, 4, 10, 18, 19]

Status = Literal["ALIVE", "NOT_ALIVE", "INVALID_DEVICE_ID", "UNKNOWN"]


def login_api(max_attempts: int = 5, timeout_sec: int = 30):
    attempts = 0
    while attempts < max_attempts:
        try:
            r = requests.post(
                AUTH_TOKEN_URL,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={
                    "client_id": CLIENT_ID,
                    "grant_type": GRANT_TYPE,
                    "username": USERNAME,
                    "password": PASSWORD,
                },
                timeout=timeout_sec,
            )
            r.raise_for_status()
            token_json = r.json()
            access_token = token_json["access_token"]

            r2 = requests.post(
                AUTH_SESSION_URL,
                headers={"Authorization": f"bearer {access_token}"},
                timeout=timeout_sec,
            )
            r2.raise_for_status()
            session_json = r2.json()
            session_key = session_json["session"]["session_id"]

            if not session_key or session_key.strip() == "":
                raise Exception("Empty session_key")

            return session_key, access_token

        except Exception as e:
            attempts += 1
            print(f"[login_api] Error: {e}. Attempt: {attempts}/{max_attempts}")
            time.sleep(2 ** attempts)

    raise RuntimeError("Login failed after retries")


def keepalive_status(device_id: str, session_key: str, access_token: str, threshold_minutes: int = 12, timeout_sec: int = 30) -> Status:
    """
    Returns:
      ALIVE / NOT_ALIVE if keepAlive timestamp is found,
      INVALID_DEVICE_ID if device is not present in ops-data for any product_id,
      UNKNOWN if requests keep failing and we can't conclude.
    """
    headers = {
        "session-key": session_key,
        "Content-Type": "application/json",
        "Authorization": f"Bearer {access_token}",
    }

    saw_success_empty_opsdata = False
    saw_any_success_with_data = False
    saw_any_request_error = False

    for pid in PRODUCT_IDS_TO_TRY:
        payload = {
            "filter": {"device_id": {"in": [str(device_id)]}, "product_id": {"in": [pid]}},
            "page": {"offset": 0, "limit": 20},
            "sort": {"param": "device_id", "order": "ASC"},
        }

        try:
            r = requests.post(OPS_DATA_URL, headers=headers, json=payload, timeout=timeout_sec)
            r.raise_for_status()
            resp = r.json()

            if resp.get("status") != "SUCCESS":
                # Could be auth/session issues or bad request; keep trying other pids
                continue

            ops_data = (resp.get("data") or {}).get("opsData") or []
            if not ops_data:
                saw_success_empty_opsdata = True
                continue

            saw_any_success_with_data = True

            ts_ms = (ops_data[0].get("keepAliveData") or {}).get("timestamp")
            if ts_ms is None:
                # Data exists but keepalive not present; try other pid (or treat as not alive)
                continue

            now_utc = datetime.now(timezone.utc)
            ka_time_utc = datetime.fromtimestamp(int(ts_ms) / 1000, tz=timezone.utc)
            print(f"\nDevice: {device_id}")
            print(f"Current UTC: {now_utc}")
            print(f"KeepAlive UTC: {ka_time_utc}")
            print(f"Time difference: {(now_utc - ka_time_utc)}")

            age_ok = (now_utc - ka_time_utc) <= timedelta(minutes=threshold_minutes)
            return "ALIVE" if age_ok else "NOT_ALIVE"


        except Exception:
            saw_any_request_error = True
            continue

    # Decision logic after trying all product_ids
    if not saw_any_success_with_data and saw_success_empty_opsdata:
        # We were able to talk to ops-data successfully, but device never appeared.
        return "INVALID_DEVICE_ID"

    if saw_any_request_error and not (saw_success_empty_opsdata or saw_any_success_with_data):
        # Everything failed (timeouts, network, auth), cannot conclude
        return "UNKNOWN"

    # We got responses but never found keepalive timestamp; treat as unknown by default
    return "UNKNOWN"


def main():
    parser = argparse.ArgumentParser(description="Check device keepalive status")
    parser.add_argument("--device_ids", type=str, required=True,
                        help="Comma-separated device IDs to check")
    parser.add_argument("--threshold", type=int, default=12,
                        help="Minutes threshold to consider device alive")
    args = parser.parse_args()

    device_ids = [d.strip() for d in args.device_ids.split(",") if d.strip()]

    if not device_ids:
        print("Error: No device IDs provided.")
        print(json.dumps({"status": "fail", "error": "No device IDs provided"}))
        sys.exit(1)

    print(f"Checking {len(device_ids)} device(s) with threshold={args.threshold}min...")
    print()

    session_key, access_token = login_api()

    results = {}
    for did in device_ids:
        status = keepalive_status(did, session_key, access_token, threshold_minutes=args.threshold)
        results[did] = status
        print(f"{did},{status}")

    alive = sorted(d for d, s in results.items() if s == "ALIVE")
    not_alive = sorted(d for d, s in results.items() if s != "ALIVE")

    # ---- Pretty summary ----
    print(f"\n{'='*50}")
    print(f"KEEPALIVE CHECK RESULTS")
    print(f"{'='*50}")
    print(f"  Total devices:  {len(results)}")
    print(f"  Alive:          {len(alive)}")
    print(f"  Not Alive:      {len(not_alive)}")

    if alive:
        print(f"\n  ✅ Alive:")
        for d in alive:
            print(f"     • {d}")

    if not_alive:
        print(f"\n  ❌ Not Alive:")
        for d in not_alive:
            print(f"     • {d} ({results[d]})")

    # Determine overall status
    if len(alive) == len(device_ids):
        overall = "pass"
        print(f"\n  STATUS: ✅ PASS — All devices alive")
    elif len(alive) > 0:
        overall = "partial_pass"
        print(f"\n  STATUS: ⚠️  PARTIAL PASS — {len(alive)}/{len(device_ids)} devices alive")
    else:
        overall = "fail"
        print(f"\n  STATUS: ❌ FAIL — No devices alive")

    print(f"{'='*50}")

    # ---- Structured JSON output (parsed by workflow engine) ----
    result = {
        "status": overall,
        "results": results,
        "alive": ",".join(alive),
        "not_alive": ",".join(not_alive),
        "alive_count": len(alive),
        "not_alive_count": len(not_alive),
        "total_count": len(device_ids),
        "device_ids": ",".join(device_ids),
    }
    print(json.dumps(result))

    # Exit 0 if at least one device alive (partial pass or full pass)
    # Exit 1 only if zero devices alive
    sys.exit(0 if overall in ("pass", "partial_pass") else 1)



if __name__ == "__main__":
    main()