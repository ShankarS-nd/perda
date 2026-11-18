#!/usr/bin/env python3
"""Fetch the current base OTA version for a product from IDMS (staging).

Current base OTA = the newest OTA package (by IDMS ID) for the product that is
Active (status == 1), production ready, and not staged (stages_enabled false,
i.e. only the Edit action in the console, no Stages button). Same list the IDMS console shows
under OTA packages (GET /console/version-check/getAllVersions).

Usage:
  get_base_ota.py <product_category>       e.g. octo, krait2_global, bagheera3_in
  get_base_ota.py --device-id <device_id>  resolve the product from a device first
  get_base_ota.py --all                    base OTA for krait, bagheera2, krait2, krait_global, krait2_global,
                                           bagheera3, bagheera3_global, octo

Env overrides: IDMS_AUTH_URL, IDMS_URL, IDMS_USER, IDMS_PASSWORD
"""
import argparse
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

AUTH_URL = os.environ.get("IDMS_AUTH_URL", "https://auth-staging.netradyne.com/authserver/api/v1")
IDMS_URL = os.environ.get("IDMS_URL", "https://idms-staging.netradyne.com/restserver/api/v1")
USERNAME = os.environ.get("IDMS_USER", "device-test-automation")
PASSWORD = os.environ.get("IDMS_PASSWORD", "devicetestautomation")

PRODUCT_ID_TO_NAME = {
    2: "bagheera", 4: "bagheera_india", 9: "krait", 10: "krait_india",
    11: "bagheera2", 12: "krait2", 13: "krait_global", 14: "krait2_global",
    15: "bagheera3", 16: "bagheera3_global", 18: "octo", 19: "octo_global",
}

# Products --all reports (the ones we need base OTAs for)
REQUIRED_PRODUCT_IDS = [9, 11, 12, 13, 14, 15, 16, 18]  # krait, bagheera2, krait2, krait_global,
# krait2_global, bagheera3, bagheera3_global, octo

PRODUCT_NAME_TO_ID = {
    "bagheera": 2, "bagheera_na": 2,
    "bagheera_india": 4, "bagheera_in": 4, "bagheera2_in": 4,
    "krait": 9, "krait_na": 9, "krait1": 9,
    "krait_india": 10, "krait_in": 10,
    "bagheera2": 11, "bagheera2_na": 11,
    "krait2": 12, "krait2_na": 12,
    "krait_global": 13, "krait_uk": 13,
    "krait2_global": 14, "krait2_in": 14,
    "bagheera3": 15, "bagheera3_na": 15,
    "bagheera3_global": 16, "bagheera3_in": 16,
    "octo": 18, "octo_na": 18,
    "octo_global": 19, "octo_in": 19,
}


class Unauthorized(Exception):
    pass


def _request(url, method="GET", headers=None, data=None, attempts=4):
    """JSON request; retries dropped connections (the specialpackages payload is several MB)."""
    last = None
    for i in range(attempts):
        req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise Unauthorized(url)
            sys.exit(f"ERROR: {method} {url} -> HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
        except (urllib.error.URLError, http.client.HTTPException, ConnectionError,
                TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(2 * (i + 1))
    sys.exit(f"ERROR: {method} {url} failed after {attempts} attempts: {last!r}")


def login():
    """Return (access_token, session_id)."""
    body = urllib.parse.urlencode({
        "client_id": "idms", "grant_type": "password",
        "username": USERNAME, "password": PASSWORD,
    }).encode()
    token = _request(f"{AUTH_URL}/oauth/token", "POST",
                     {"Content-Type": "application/x-www-form-urlencoded"}, body)["access_token"]
    session = _request(f"{AUTH_URL}/session", "POST", {"Authorization": f"bearer {token}"})
    return token, session["session"]["session_id"]


def _auth_headers(token, session_id):
    return {"session-key": session_id, "Content-Type": "application/json",
            "Authorization": f"Bearer {token}"}


def get_product_id(device_id):
    token, session_id = login()
    url = f"{IDMS_URL}/opsdashboard/deviceAssociationDetails?" + urllib.parse.urlencode({"deviceId": device_id})
    return _request(url, headers=_auth_headers(token, session_id))["data"]["deviceDetails"]["productId"]


def fetch_versions(attempts=3):
    """Download all OTA package records; log in fresh each try in case the token is rejected."""
    for _ in range(attempts):
        token, session_id = login()
        try:
            resp = _request(f"{IDMS_URL}/console/version-check/getAllVersions",
                            headers=_auth_headers(token, session_id))
        except Unauthorized:
            continue
        if not resp.get("response"):
            sys.exit("ERROR: API returned false response")
        versions = resp["data"]["versions"]
        return json.loads(versions) if isinstance(versions, str) else versions
    sys.exit("ERROR: token rejected repeatedly (401)")


def latest_base_ota(versions, product_id):
    """Newest Active + production-ready + non-staged OTA version for the product, or None."""
    ok = [v for v in versions
          if v.get("productId") == product_id and v.get("status") == 1 and v.get("productionReady")
          and not v.get("stages_enabled")]
    return max(ok, key=lambda v: v["ID"])["C_P_Version"] if ok else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("product", nargs="?", help="product category/alias (e.g. octo, krait2_global)")
    ap.add_argument("--device-id", help="look up the product from this device id instead")
    ap.add_argument("--all", action="store_true", help="print the base OTA for every product ")
    args = ap.parse_args()
    if not (args.product or args.device_id or args.all):
        ap.error("give a product category, --device-id, or --all")

    if args.all:
        versions = fetch_versions()
        for pid in REQUIRED_PRODUCT_IDS:
            print(f"{PRODUCT_ID_TO_NAME[pid]}: {latest_base_ota(versions, pid) or '-'}")
        return

    if args.device_id:
        product_id = get_product_id(args.device_id)
    else:
        product_id = PRODUCT_NAME_TO_ID.get(args.product.lower())
        if product_id is None:
            sys.exit(f"ERROR: Unknown product: {args.product}")

    ota = latest_base_ota(fetch_versions(), product_id)
    if not ota:
        sys.exit(f"ERROR: Could not fetch base OTA for {PRODUCT_ID_TO_NAME.get(product_id, product_id)}")
    print(ota)


if __name__ == "__main__":
    main()
