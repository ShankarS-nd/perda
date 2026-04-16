#!/usr/bin/env python3
"""
RC Comparison Script (Jenkins Integration)
===========================================
Compares two release candidate DAST reports by fetching them directly from
Jenkins build pages.

Input: Two Jenkins build numbers + platform name.

The script downloads ``static/scr.js`` from each build's published HTML
report (Test_5freport) and parses the embedded JSON data structures.

Identifies:
  - Regression failures (PASS in RC1 → FAIL in RC2) with TC IDs
  - Unknown errors (failures with no linked Jira issues)
  - Known errors (failures with linked Jira issues)
  - Fixed tests (FAIL in RC1 → PASS in RC2)
  - New / removed test cases between RCs

Output:
  - Console: Service-level summary comparison + regression details
  - CSV: Detailed regression, unknown, and known failure lists with TC IDs

Authentication:
  Set environment variables JENKINS_USER and JENKINS_TOKEN.
"""

import argparse
import json
import os
import re
import sys
import tarfile
import tempfile
from pathlib import Path

import requests
import pandas as pd
from dotenv import load_dotenv
from wcwidth import wcswidth

# Load .env file (for standalone execution outside FastAPI)
load_dotenv()

# =====================================================================
# SCRIPT METADATA — consumed by Perda script runner
# =====================================================================

SCRIPT_CWD = "."
SCRIPT_OUTPUTS = "./output/rc_comparison"

# Local cache directory for pre-downloaded scr.js files
# Stored at  backend/cache/scrjs/<build_number>.js
SCRJS_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "scrjs"

# ── Device serial-number registries per platform ────────────────────
# Each key is a platform label; value is a list of serial numbers.
DEVICE_SERIALS = {
    # India
    "B3_IN":  ["103062502272", "103062503140", "103062502237", "103062503146",
               "103062502313", "103062502262", "103062502244"],
    "K2_IN":  ["6603083392", "6603083366", "6603083426", "6603075403",
               "6603083414", "6603022466", "6603083621"],
    # UK
    "K1_UK":  ["264130567", "264129228", "264130566", "264032054",
               "264115664", "264130581", "264031826"],
    # US
    "B3_US":  ["103112400111", "103142400150", "103112400110", "103142400160",
               "103212400447", "103452403643", "103452403705"],
    "K1_US":  ["264130505", "264130576", "264067412", "264065431",
               "264067487", "264129998", "264067451"],
    "K2_US":  ["6603083402", "6603083306", "6603083417", "6603073901",
               "6603085697", "6603083308", "6603029208"],
    "B2_US":  ["3633118425", "3633118738", "3633118764", "3633053124",
               "3633009572", "3633073885", "3633118314"],
}

# Mapping: model code → friendly platform name
MODEL_TO_PLATFORM = {
    "K1":  "D-210",
    "K2":  "D-215",
    "B2":  "D-430",
    "B3":  "D-450",
}

REGION_SUFFIX = {
    "US": "US",
    "UK": "UK",
    "IN": "IN",
}

# Build a quick serial → (model_region, platform_friendly) lookup
SERIAL_LOOKUP: dict[str, tuple[str, str]] = {}
for _key, _serials in DEVICE_SERIALS.items():
    _model, _region = _key.split("_")
    _platform = f"{MODEL_TO_PLATFORM.get(_model, _model)}_{REGION_SUFFIX.get(_region, _region)}"
    for _s in _serials:
        SERIAL_LOOKUP[_s] = (_key, _platform)

# All known platform labels for the dropdown
PLATFORMS = sorted(DEVICE_SERIALS.keys())

JENKINS_BASE_URL = (
    "https://build-device.netradyne.info/view/Daily_Build_Pipeline"
    "/job/Test_Automation_Parallel"
)

SCRIPT_ARGS = [
    {
        "name": "rc1",
        "type": "string",
        "description": "RC1 Jenkins build number (e.g. 1016)",
        "default": "",
        "required": True,
    },
    {
        "name": "rc2",
        "type": "string",
        "description": "RC2 Jenkins build number (e.g. 1655)",
        "default": "",
        "required": True,
    },
    {
        "name": "platform",
        "type": "string",
        "description": (
            "Platform key: "
            + ", ".join(PLATFORMS)
        ),
        "default": "K1_US",
        "required": False,
    },
]

# =====================================================================
# JENKINS URL PARSING
# =====================================================================


def parse_jenkins_url(url: str) -> tuple[str, str]:
    """Parse a full Jenkins build URL into (job_base_url, build_number).

    Accepts URLs like:
      https://build-device.netradyne.info/view/.../job/SomeJob/123/
      https://build-device.netradyne.info/job/SomeJob/123

    Returns:
      ("https://build-device.netradyne.info/view/.../job/SomeJob", "123")
    """
    url = url.strip().rstrip("/")
    m = re.match(r"(https?://.+/job/[^/]+)/(\d+)$", url)
    if not m:
        raise ValueError(
            f"Cannot parse Jenkins URL: {url!r}. "
            f"Expected format: https://<host>/...job/<job_name>/<build_number>"
        )
    return m.group(1), m.group(2)


def _url_cache_key(job_base_url: str, build_number: str) -> str:
    """Derive a short, filesystem-safe cache key from a job URL + build number.

    For the default job, returns just the build number (backward compatible).
    For other jobs, returns '<job_name>_<build_number>'.
    """
    if job_base_url.rstrip("/") == JENKINS_BASE_URL.rstrip("/"):
        return build_number
    # Extract job name from the URL
    m = re.search(r"/job/([^/]+)$", job_base_url.rstrip("/"))
    job_name = m.group(1) if m else "custom"
    # Sanitize job name for filesystem
    safe_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", job_name)
    return f"{safe_name}_{build_number}"


# =====================================================================
# JENKINS FETCH
# =====================================================================


def _jenkins_session() -> requests.Session:
    """Build an authenticated requests session from env vars."""
    user = os.environ.get("JENKINS_USER", "")
    token = os.environ.get("JENKINS_TOKEN", "")
    sess = requests.Session()
    if user and token:
        sess.auth = (user, token)
    sess.headers.update({"User-Agent": "Perda-RC-Comparison/1.0"})
    return sess


def _check_auth(resp: requests.Response) -> None:
    """Exit with a clear message on auth failures."""
    if resp.status_code == 401:
        sys.exit(
            "❌ Jenkins authentication failed (401). "
            "Set JENKINS_USER and JENKINS_TOKEN environment variables."
        )
    if resp.status_code == 403:
        sys.exit(
            "❌ Jenkins access denied (403). "
            "Check your JENKINS_USER / JENKINS_TOKEN credentials."
        )


def _is_auth_redirect(resp: requests.Response) -> bool:
    """Check if a response is a Jenkins auth redirect (expired token)."""
    if resp.status_code in (301, 302, 303, 307, 308):
        location = resp.headers.get("Location", "")
        if "commenceLogin" in location or "securityRealm" in location:
            return True
    return False


def _fetch_published_scrjs(build_number: str, session: requests.Session) -> str | None:
    """Try to get static/scr.js from the published HTML report."""
    url = f"{JENKINS_BASE_URL}/{build_number}/Test_5freport/static/scr.js"
    print(f"  ↓ Trying published report data: {url}")
    try:
        resp = session.get(url, timeout=180, allow_redirects=False)
    except requests.exceptions.TooManyRedirects:
        print(f"    ⚠ Redirect loop for build {build_number} (report likely doesn't exist), will try artifact…")
        return None
    if _is_auth_redirect(resp):
        sys.exit(
            "❌ Jenkins authentication failed (redirect to login). "
            "Your JENKINS_TOKEN has likely expired. "
            "Please generate a new API token at Jenkins → User → Configure → API Token and update .env."
        )
    _check_auth(resp)
    if resp.status_code == 404:
        print("    ⚠ Published scr.js not found (404), will try artifact…")
        return None
    if resp.status_code in (301, 302, 303, 307, 308):
        # Non-auth redirect — follow it manually once
        resp = session.get(resp.headers.get("Location", url), timeout=180)
        _check_auth(resp)
        if resp.status_code == 404:
            print("    ⚠ Published scr.js not found (404 after redirect), will try artifact…")
            return None
    resp.raise_for_status()
    print(f"    ✓ Downloaded ({len(resp.content):,} bytes)")
    return resp.text


def _fetch_artifact_scrjs(build_number: str, session: requests.Session) -> str:
    """Download report.tar.gz artifact, extract and return static/scr.js."""
    url = f"{JENKINS_BASE_URL}/{build_number}/artifact/report/report.tar.gz"
    print(f"  ↓ Downloading artifact: {url}")
    try:
        resp = session.get(url, timeout=300, stream=True, allow_redirects=False)
    except requests.exceptions.TooManyRedirects:
        sys.exit(
            f"❌ Build {build_number}: Report not available (Jenkins redirect loop). "
            f"The build may not exist or the test report was never generated."
        )
    if _is_auth_redirect(resp):
        sys.exit(
            "❌ Jenkins authentication failed (redirect to login). "
            "Your JENKINS_TOKEN has likely expired. "
            "Please generate a new API token at Jenkins → User → Configure → API Token and update .env."
        )
    _check_auth(resp)
    if resp.status_code in (301, 302, 303, 307, 308):
        # Follow non-auth redirects
        resp = session.get(resp.headers.get("Location", url), timeout=300, stream=True)
        _check_auth(resp)
    if resp.status_code == 404:
        sys.exit(
            f"❌ Build {build_number}: Neither published report nor "
            f"artifact report.tar.gz found. Check the build number."
        )
    resp.raise_for_status()

    with tempfile.TemporaryDirectory() as tmpdir:
        tar_path = os.path.join(tmpdir, "report.tar.gz")
        with open(tar_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                f.write(chunk)
        print(f"    ✓ Downloaded ({os.path.getsize(tar_path):,} bytes), extracting…")

        with tarfile.open(tar_path, "r:gz") as tar:
            tar.extractall(tmpdir, filter="data")

        # Search for scr.js inside the extracted contents
        scr_js_path = None
        for root, _dirs, files in os.walk(tmpdir):
            for fname in files:
                if fname == "scr.js":
                    scr_js_path = os.path.join(root, fname)
                    break
            if scr_js_path:
                break

        if not scr_js_path:
            sys.exit(
                f"❌ Build {build_number}: report.tar.gz downloaded but "
                f"no static/scr.js found inside."
            )

        with open(scr_js_path, "r", encoding="utf-8", errors="replace") as f:
            js_content = f.read()

        print(f"    ✓ Extracted scr.js ({len(js_content):,} bytes)")
        return js_content


def fetch_report_js(
    build_number: str,
    session: requests.Session,
    use_cache: bool = True,
) -> str:
    """Fetch DAST report scr.js for a build.

    Strategy:
      0. Return from local disk cache if available and use_cache=True.
      1. Try published scr.js at Test_5freport/static/scr.js
      2. Fall back to downloading artifact/report/report.tar.gz and extracting.
      3. Always persist the fetched content to disk cache for future calls.
    """
    cache_file = SCRJS_CACHE_DIR / f"{build_number}.js"
    if use_cache and cache_file.is_file():
        print(f"  ✓ Using cached scr.js for build {build_number} ({cache_file.stat().st_size:,} bytes)")
        return cache_file.read_text(encoding="utf-8")

    js = _fetch_published_scrjs(build_number, session)
    if js is None:
        js = _fetch_artifact_scrjs(build_number, session)

    # Always persist to cache so future calls skip Jenkins entirely
    SCRJS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(js, encoding="utf-8")
    print(f"  💾 Saved scr.js to cache: {cache_file}")

    return js


def fetch_report_js_from_url(
    jenkins_url: str,
    session: requests.Session,
    use_cache: bool = True,
) -> tuple[str, str, str]:
    """Fetch DAST report scr.js from an arbitrary Jenkins build URL.

    Parameters:
        jenkins_url: Full Jenkins build URL, e.g.
            https://build-device.netradyne.info/view/.../job/SomeJob/123/
        session: Authenticated requests session.
        use_cache: Whether to check local cache first.

    Returns:
        (js_content, job_base_url, build_number)
    """
    job_base_url, build_number = parse_jenkins_url(jenkins_url)
    cache_key = _url_cache_key(job_base_url, build_number)
    cache_file = SCRJS_CACHE_DIR / f"{cache_key}.js"

    if use_cache and cache_file.is_file():
        print(f"  ✓ Using cached scr.js for {cache_key} ({cache_file.stat().st_size:,} bytes)")
        return cache_file.read_text(encoding="utf-8"), job_base_url, build_number

    # Try published scr.js
    pub_url = f"{job_base_url}/{build_number}/Test_5freport/static/scr.js"
    print(f"  ↓ Trying published report data: {pub_url}")
    js: str | None = None
    try:
        resp = session.get(pub_url, timeout=180, allow_redirects=False)
        if _is_auth_redirect(resp):
            sys.exit(
                "❌ Jenkins authentication failed (redirect to login). "
                "Your JENKINS_TOKEN has likely expired."
            )
        _check_auth(resp)
        if resp.status_code == 200:
            print(f"    ✓ Downloaded ({len(resp.content):,} bytes)")
            js = resp.text
        elif resp.status_code in (301, 302, 303, 307, 308):
            resp2 = session.get(resp.headers.get("Location", pub_url), timeout=180)
            _check_auth(resp2)
            if resp2.status_code == 200:
                js = resp2.text
    except requests.exceptions.TooManyRedirects:
        pass

    # Fall back to artifact
    if js is None:
        art_url = f"{job_base_url}/{build_number}/artifact/report/report.tar.gz"
        print(f"  ↓ Trying artifact: {art_url}")
        try:
            resp = session.get(art_url, timeout=300, stream=True, allow_redirects=False)
            if _is_auth_redirect(resp):
                sys.exit("❌ Jenkins auth failed (redirect to login).")
            _check_auth(resp)
            if resp.status_code in (301, 302, 303, 307, 308):
                resp = session.get(resp.headers.get("Location", art_url), timeout=300, stream=True)
                _check_auth(resp)
            if resp.status_code == 404:
                raise RuntimeError(
                    f"Build at {jenkins_url}: Neither published report nor "
                    f"artifact report.tar.gz found."
                )
            resp.raise_for_status()

            with tempfile.TemporaryDirectory() as tmpdir:
                tar_path = os.path.join(tmpdir, "report.tar.gz")
                with open(tar_path, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=65536):
                        f.write(chunk)
                with tarfile.open(tar_path, "r:gz") as tar:
                    tar.extractall(tmpdir, filter="data")
                scr_js_path = None
                for root, _dirs, files in os.walk(tmpdir):
                    for fname in files:
                        if fname == "scr.js":
                            scr_js_path = os.path.join(root, fname)
                            break
                    if scr_js_path:
                        break
                if not scr_js_path:
                    raise RuntimeError(
                        f"Build at {jenkins_url}: report.tar.gz downloaded but "
                        f"no static/scr.js found inside."
                    )
                with open(scr_js_path, "r", encoding="utf-8", errors="replace") as f:
                    js = f.read()
        except requests.exceptions.TooManyRedirects:
            raise RuntimeError(
                f"Build at {jenkins_url}: Jenkins redirect loop. "
                f"The build may not exist or the test report was never generated."
            )

    # Persist to cache
    SCRJS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(js, encoding="utf-8")
    print(f"  💾 Saved scr.js to cache: {cache_file}")

    return js, job_base_url, build_number


def fetch_dast_known_unknown_counts(
    build_number: str,
    session: requests.Session,
) -> tuple[int | None, int | None]:
    """Fetch authoritative known/unknown failure counts from the DAST HTML pages.

    Tries to download ``linked_issues.html`` and ``unknown_issue.html`` from the
    published Jenkins report and parse the count shown in each page's header.

    Returns (known_count, unknown_count).  Either value may be ``None`` if the
    page is not accessible.
    """
    known: int | None = None
    unknown: int | None = None

    for page, label in [("linked_issues.html", "known"), ("unknown_issue.html", "unknown")]:
        url = f"{JENKINS_BASE_URL}/{build_number}/Test_5freport/{page}"
        try:
            resp = session.get(url, timeout=30, allow_redirects=False)
            if _is_auth_redirect(resp):
                continue  # skip on auth failure
            if resp.status_code != 200 or len(resp.content) < 100:
                continue
            text = resp.text[:5000]
            if label == "known":
                # Pattern in linked_issues.html header table (DOTALL needed for newlines)
                m = re.search(r"Total Failed Test Cases with Linked Issues.*?(\d+)", text, re.DOTALL)
                if not m:
                    # Fallback: count from index.html-style template
                    m = re.search(r"Known Issues Count:\s*(\d+)", text)
                if m:
                    known = int(m.group(1))
            else:
                # unknown_issue.html header: "Total Failed Test Cases" followed by count
                m = re.search(r"Total Failed Test Cases(?!.*Linked).*?(\d+)", text, re.DOTALL)
                if m:
                    unknown = int(m.group(1))
                else:
                    # First number in the header area is usually the count
                    nums = re.findall(r">(\d+)<", text[:2000])
                    if nums:
                        unknown = int(nums[0])
        except Exception:
            pass

    return known, unknown


def fetch_dast_counts_from_url(
    job_base_url: str,
    build_number: str,
    session: requests.Session,
) -> tuple[int | None, int | None]:
    """Like fetch_dast_known_unknown_counts but with a custom job base URL."""
    known: int | None = None
    unknown: int | None = None

    for page, label in [("linked_issues.html", "known"), ("unknown_issue.html", "unknown")]:
        url = f"{job_base_url}/{build_number}/Test_5freport/{page}"
        try:
            resp = session.get(url, timeout=30, allow_redirects=False)
            if _is_auth_redirect(resp):
                continue
            if resp.status_code != 200 or len(resp.content) < 100:
                continue
            text = resp.text[:5000]
            if label == "known":
                m = re.search(r"Total Failed Test Cases with Linked Issues.*?(\d+)", text, re.DOTALL)
                if not m:
                    m = re.search(r"Known Issues Count:\s*(\d+)", text)
                if m:
                    known = int(m.group(1))
            else:
                m = re.search(r"Total Failed Test Cases(?!.*Linked).*?(\d+)", text, re.DOTALL)
                if m:
                    unknown = int(m.group(1))
                else:
                    nums = re.findall(r">(\d+)<", text[:2000])
                    if nums:
                        unknown = int(nums[0])
        except Exception:
            pass

    return known, unknown


# =====================================================================
# JS PARSING – extract JSON variables from scr.js
# =====================================================================


def _extract_js_variable(js_text: str, var_name: str):
    """Extract and parse the JSON value assigned to a top-level const in scr.js.

    The scr.js file has multiple ``const X = <JSON>;`` blocks, followed
    by JavaScript function definitions.  We locate the start of the value
    and use ``json.JSONDecoder.raw_decode`` to consume exactly the JSON
    portion, ignoring any trailing JS code.

    Returns the parsed Python object (list or dict).
    """
    pattern = re.compile(r"^const\s+" + re.escape(var_name) + r"\s*=\s*", re.MULTILINE)
    m = pattern.search(js_text)
    if not m:
        raise KeyError(f"Variable '{var_name}' not found in scr.js")

    val_start = m.end()
    decoder = json.JSONDecoder()
    obj, _end = decoder.raw_decode(js_text, val_start)
    return obj


# =====================================================================
# HELPERS
# =====================================================================


def extract_tc_id(testcase_name: str) -> str:
    """Extract TC ID from testcase name.  TC_940_AWSIOT_… → TC-940"""
    m = re.match(r"TC[_-](\d+)", str(testcase_name).strip())
    return f"TC-{m.group(1)}" if m else "UNKNOWN"


# Jira statuses that indicate the issue is resolved / no longer active.
# Test cases whose linked issues are ALL in these statuses are treated as
# "unknown failures" (the existing fix should have addressed the issue).
_RESOLVED_STATUSES = frozenset({
    "CLOSED", "DONE", "RESOLVED",
})

# Jira project prefixes that represent test cases, NOT defect/bug tickets.
# The DAST report only counts actual defect tickets (DT-*, DTA-*, ITN-*,
# OCTO-*, IDMS-*, etc.) as "linked issues" for known-failure classification.
# TC-* entries are self-references to the test case Jira item and are ignored.
_TESTCASE_PREFIXES = ("TC-",)


def _format_linked_issues(linked: list, *, active_only: bool = True) -> str:
    """Format linked_issues_status array into a display string.

    Input : [['TC-183', 'In Progress', 'https://…'], ['DT-1080', 'Open', …]]
    Output: 'DT-1080 (Open)'

    Filtering rules (when *active_only* is True, the default):
      1. Entries like ['NA', 'NA', 'NA'] are skipped (no real Jira link).
      2. TC-* prefixed tickets are skipped (test-case self-references, not
         defect tickets).
      3. Entries whose status is Closed / Done / Resolved are skipped.

    This matches the Jenkins DAST report behaviour where a test case is only a
    "known failure" if it has at least one active defect ticket linked.
    """
    if not linked or not isinstance(linked, list):
        return ""
    parts = []
    for item in linked:
        if isinstance(item, list) and len(item) >= 2:
            ticket_id = str(item[0]).strip().upper()
            # Skip placeholder entries that indicate no real linked issue
            if ticket_id in ("NA", "NONE", "", "NAN"):
                continue
            if active_only:
                # Skip test-case self-reference tickets (TC-*)
                if any(ticket_id.startswith(p) for p in _TESTCASE_PREFIXES):
                    continue
                # Skip resolved/closed issues
                status = str(item[1]).strip().upper()
                if status in _RESOLVED_STATUSES:
                    continue
            parts.append(f"{item[0]} ({item[1]})")
        elif isinstance(item, str):
            if item.strip().upper() not in ("NA", "NONE", "", "NAN"):
                parts.append(item)
    return ", ".join(parts)


def _extract_error_data(test_steps: list) -> str:
    """Extract failing steps from Test_Steps as a summary string.

    Input : [{'step desc': 'Pass'}, {'some check': 'Fail'}, …]
    Output: 'some check'
    """
    if not test_steps or not isinstance(test_steps, list):
        return ""
    failures = []
    for step in test_steps:
        if isinstance(step, dict):
            for desc, status in step.items():
                if str(status).strip().upper() == "FAIL":
                    failures.append(desc.strip())
    return "; ".join(failures[:3])  # first 3 failing steps


# =====================================================================
# PARSING (from scr.js JSON data)
# =====================================================================


def parse_report_data(js_text: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Parse scr.js into (service_summary_df, testcase_df).

    Extracts the ``output`` and ``service_level`` JSON variables from the
    JavaScript file.

    Returns
    -------
    service_summary_df : DataFrame
        Columns: Service Name, Total TC, Pass, Fail, Not Executed, Not Applicable, Pass%
    testcase_df : DataFrame
        Columns: Testcase Name, Result, Error Data, Linked Issues, Service
    """
    # ---- test case data from 'output' variable ----
    output_data: list[dict] = _extract_js_variable(js_text, "output")

    tc_rows = []
    for entry in output_data:
        linked_str = _format_linked_issues(entry.get("linked_issues_status", []))
        error_str = _extract_error_data(entry.get("Test_Steps", []))

        tc_rows.append({
            "Testcase Name": entry.get("file_name", ""),
            "Result": entry.get("test_status", "NA"),
            "Error Data": error_str if error_str else "NA",
            "Linked Issues": linked_str if linked_str else "NA",
            "Service": entry.get("service", "OTHER"),
        })

    tc_df = pd.DataFrame(tc_rows)

    # ---- service-level summary from 'service_level' variable ----
    sl_data: list[dict] = _extract_js_variable(js_text, "service_level")

    svc_rows = []
    # sl_data is a list with 1 element: {device_id: {service: [P, F, NE, NA]}}
    # Aggregate across all devices.
    aggregated: dict[str, list[int]] = {}  # service → [pass, fail, NE, NA]

    for device_dict in sl_data:
        for _device_id, services in device_dict.items():
            for svc_name, counts in services.items():
                if svc_name not in aggregated:
                    aggregated[svc_name] = [0, 0, 0, 0]
                for j in range(4):
                    aggregated[svc_name][j] += counts[j]

    for svc_name, (p, f, ne, na) in aggregated.items():
        total = p + f + ne + na
        applicable = p + f + ne
        pass_pct = round((p / applicable) * 100, 2) if applicable > 0 else 0.0
        svc_rows.append({
            "Service Name": svc_name,
            "Total TC": total,
            "Pass": p,
            "Fail": f,
            "Not Executed": ne,
            "Not Applicable": na,
            "Pass%": pass_pct,
        })

    svc_df = pd.DataFrame(svc_rows)

    return svc_df, tc_df


def aggregate_results(tc_df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate per-device results to one row per unique Testcase Name."""
    tc_df = tc_df.copy()
    tc_df["Result"] = tc_df["Result"].astype(str).str.upper().str.strip()

    def _agg(grp):
        results = grp["Result"].tolist()
        errors = grp["Error Data"].tolist()
        issues = grp["Linked Issues"].tolist()
        services = grp["Service"].tolist()

        if "FAIL" in results:
            idx = results.index("FAIL")
        elif "PASS" in results:
            idx = results.index("PASS")
        else:
            idx = 0

        return pd.Series({
            "Result": results[idx],
            "Error Data": errors[idx],
            "Linked Issues": issues[idx],
            "Service": services[idx],
        })

    return tc_df.groupby("Testcase Name", group_keys=False).apply(_agg).reset_index()


# =====================================================================
# DISPLAY HELPERS
# =====================================================================


def pad(text: str, width: int) -> str:
    display_w = wcswidth(text)
    if display_w < 0:
        display_w = len(text)
    return text + " " * max(0, width - display_w)


def is_linked(val) -> bool:
    s = str(val).strip().upper()
    if s in ("", "NA", "NAN", "NONE", "[]", "NA (NA)"):
        return False
    # Catch patterns like 'NA (NA), NA (NA)' — all entries are NA
    cleaned = s.replace("NA (NA)", "").replace(",", "").strip()
    return len(cleaned) > 0


# =====================================================================
# MAIN
# =====================================================================


def main():
    parser = argparse.ArgumentParser(description="RC Comparison Script (Jenkins)")
    parser.add_argument("--rc1", type=str, required=True, help="RC1 Jenkins build number")
    parser.add_argument("--rc2", type=str, required=True, help="RC2 Jenkins build number")
    parser.add_argument(
        "--platform",
        type=str,
        default="K1_US",
        help=f"Platform key: {', '.join(PLATFORMS)}",
    )
    args = parser.parse_args()

    rc1_label = args.rc1.strip()
    rc2_label = args.rc2.strip()
    platform = args.platform.strip().upper()

    if platform not in DEVICE_SERIALS:
        sys.exit(
            f"❌ Unknown platform '{platform}'. "
            f"Valid options: {', '.join(PLATFORMS)}"
        )

    serials = DEVICE_SERIALS[platform]
    friendly = SERIAL_LOOKUP[serials[0]][1]  # e.g. "D-210_US"

    output_dir = f"output/rc_comparison/{friendly}/{rc1_label}_vs_{rc2_label}"
    os.makedirs(output_dir, exist_ok=True)

    print(f"\n{'='*72}")
    print(f"  RC Comparison: Build {rc1_label} vs Build {rc2_label}  ({friendly} / {platform})")
    print(f"{'='*72}")
    print(f"  Platform  : {platform} ({friendly})")
    print(f"  Devices   : {len(serials)} serial numbers")
    print(f"  Output dir: {output_dir}\n")

    # ---------- fetch reports from Jenkins ----------
    session = _jenkins_session()

    print("  Downloading RC1 report data…")
    rc1_js = fetch_report_js(rc1_label, session)
    print(f"  ✓ RC1 scr.js fetched ({len(rc1_js):,} bytes)")

    print("  Downloading RC2 report data…")
    rc2_js = fetch_report_js(rc2_label, session)
    print(f"  ✓ RC2 scr.js fetched ({len(rc2_js):,} bytes)\n")

    # ---------- parse service summaries & test cases ----------
    print("  Parsing RC1 data…")
    svc1, tc1_raw = parse_report_data(rc1_js)
    print(f"    ✓ {len(tc1_raw)} test entries, {len(svc1)} services")

    print("  Parsing RC2 data…")
    svc2, tc2_raw = parse_report_data(rc2_js)
    print(f"    ✓ {len(tc2_raw)} test entries, {len(svc2)} services\n")

    all_services = sorted(
        set(svc1["Service Name"].tolist() + svc2["Service Name"].tolist())
    )

    # ---------- aggregate test cases ----------
    tc1 = aggregate_results(tc1_raw)
    tc2 = aggregate_results(tc2_raw)

    for df in [tc1, tc2]:
        df["TC_ID"] = df["Testcase Name"].apply(extract_tc_id)
        # Service column is already present from parse_report_data

    # ---------- merge ----------
    rc1_df = tc1.rename(columns={
        "Result": "RC1_Result",
        "Error Data": "RC1_Error",
        "Linked Issues": "RC1_Linked",
    })
    rc2_df = tc2.rename(columns={
        "Result": "RC2_Result",
        "Error Data": "RC2_Error",
        "Linked Issues": "RC2_Linked",
    })

    merged = pd.merge(
        rc1_df[["Testcase Name", "TC_ID", "Service", "RC1_Result", "RC1_Error", "RC1_Linked"]],
        rc2_df[["Testcase Name", "TC_ID", "Service", "RC2_Result", "RC2_Error", "RC2_Linked"]],
        on=["Testcase Name", "TC_ID", "Service"],
        how="outer",
        indicator=True,
    )

    merged["RC1_Result"] = merged["RC1_Result"].fillna("NOT_PRESENT").str.upper().str.strip()
    merged["RC2_Result"] = merged["RC2_Result"].fillna("NOT_PRESENT").str.upper().str.strip()

    # ---------- classify ----------
    regressions = merged[
        (merged["RC1_Result"] == "PASS") & (merged["RC2_Result"] == "FAIL")
    ].copy()

    fixed = merged[
        (merged["RC1_Result"] == "FAIL") & (merged["RC2_Result"] == "PASS")
    ].copy()

    fail_both = merged[
        (merged["RC1_Result"] == "FAIL") & (merged["RC2_Result"] == "FAIL")
    ].copy()

    pass_both = merged[
        (merged["RC1_Result"] == "PASS") & (merged["RC2_Result"] == "PASS")
    ].copy()

    new_tests = merged[merged["_merge"] == "right_only"].copy()
    removed_tests = merged[merged["_merge"] == "left_only"].copy()

    reg_unknown = regressions[~regressions["RC2_Linked"].apply(is_linked)].copy()
    reg_known = regressions[regressions["RC2_Linked"].apply(is_linked)].copy()

    fail_both_unknown = fail_both[~fail_both["RC2_Linked"].apply(is_linked)].copy()
    fail_both_known = fail_both[fail_both["RC2_Linked"].apply(is_linked)].copy()

    # ================================================================
    # CONSOLE OUTPUT
    # ================================================================

    print(f"\n{'─'*72}")
    print("  OVERALL SUMMARY")
    print(f"{'─'*72}")
    total = len(merged)
    print(f"  Total unique test cases (union) : {total}")
    print(f"  Stable (PASS → PASS)            : {len(pass_both)}")
    print(f"  Fixed  (FAIL → PASS)            : {len(fixed)}")
    print(f"  Regressions (PASS → FAIL)       : {len(regressions)}")
    print(f"    ├─ Unknown (no linked issue)   : {len(reg_unknown)}")
    print(f"    └─ Known  (linked issue)       : {len(reg_known)}")
    print(f"  Persistent failures (FAIL→FAIL)  : {len(fail_both)}")
    print(f"    ├─ Unknown                     : {len(fail_both_unknown)}")
    print(f"    └─ Known                       : {len(fail_both_known)}")
    print(f"  New test cases (only in {rc2_label})  : {len(new_tests)}")
    print(f"  Removed test cases (only in {rc1_label}): {len(removed_tests)}")

    # ---- Service-level comparison ----
    col_w = 12
    svc_w = 36

    print(f"\n{'─'*72}")
    print("  SERVICE-LEVEL COMPARISON")
    print(f"{'─'*72}")

    header = (
        pad("Service", svc_w)
        + pad(f"B#{rc1_label}", col_w) + pad("", col_w)
        + pad(f"B#{rc2_label}", col_w) + pad("", col_w)
        + pad("Regress", col_w)
        + pad("Fixed", col_w)
    )
    sub_header = (
        pad("", svc_w)
        + pad("Pass", col_w) + pad("Total", col_w)
        + pad("Pass", col_w) + pad("Total", col_w)
        + pad("", col_w) + pad("", col_w)
    )
    print(header)
    print(sub_header)
    print("─" * len(header))

    for svc in all_services:
        r1 = svc1[svc1["Service Name"] == svc]
        r2 = svc2[svc2["Service Name"] == svc]

        p1 = int(r1["Pass"].iloc[0]) if not r1.empty else 0
        t1 = int(r1["Total TC"].iloc[0]) if not r1.empty else 0
        p2 = int(r2["Pass"].iloc[0]) if not r2.empty else 0
        t2 = int(r2["Total TC"].iloc[0]) if not r2.empty else 0

        svc_reg = len(regressions[regressions["Service"] == svc])
        svc_fix = len(fixed[fixed["Service"] == svc])

        line = (
            pad(svc, svc_w)
            + pad(str(p1), col_w) + pad(str(t1), col_w)
            + pad(str(p2), col_w) + pad(str(t2), col_w)
            + pad(str(svc_reg), col_w)
            + pad(str(svc_fix), col_w)
        )
        print(line)

    # ---- Regression failures detail ----
    if not regressions.empty:
        print(f"\n{'─'*72}")
        print(f"  REGRESSION FAILURES  (PASS in B#{rc1_label} → FAIL in B#{rc2_label})")
        print(f"{'─'*72}")

        for svc in sorted(regressions["Service"].unique()):
            svc_regs = regressions[regressions["Service"] == svc].sort_values("TC_ID")
            print(f"\n  [{svc}]  ({len(svc_regs)} regressions)")
            for _, row in svc_regs.iterrows():
                tag = "KNOWN" if is_linked(row["RC2_Linked"]) else "UNKNOWN"
                linked = str(row["RC2_Linked"]) if is_linked(row["RC2_Linked"]) else ""
                error_snip = str(row["RC2_Error"])[:80] if str(row["RC2_Error"]).upper() not in ("NA", "NAN") else ""
                print(f"    {row['TC_ID']:<10} {row['Testcase Name']:<55} [{tag}]")
                if linked:
                    print(f"{'':>14}Linked: {linked}")
                if error_snip:
                    print(f"{'':>14}Error : {error_snip}")
    else:
        print(f"\n  ✅ No regression failures between B#{rc1_label} and B#{rc2_label}")

    # ---- Unknown errors in RC2 ----
    rc2_all_fails = merged[merged["RC2_Result"] == "FAIL"].copy()
    rc2_unknown = rc2_all_fails[~rc2_all_fails["RC2_Linked"].apply(is_linked)].copy()
    rc2_known = rc2_all_fails[rc2_all_fails["RC2_Linked"].apply(is_linked)].copy()

    if not rc2_unknown.empty:
        print(f"\n{'─'*72}")
        print(f"  UNKNOWN ERRORS IN B#{rc2_label}  (failures with no linked Jira)")
        print(f"{'─'*72}")
        for svc in sorted(rc2_unknown["Service"].unique()):
            svc_unk = rc2_unknown[rc2_unknown["Service"] == svc].sort_values("TC_ID")
            print(f"\n  [{svc}]  ({len(svc_unk)} unknown)")
            for _, row in svc_unk.iterrows():
                src = ""
                if row["RC1_Result"] == "PASS":
                    src = " (REGRESSION)"
                elif row["RC1_Result"] == "FAIL":
                    src = " (PERSISTENT)"
                elif row["RC1_Result"] == "NOT_PRESENT":
                    src = " (NEW TC)"
                error_snip = str(row["RC2_Error"])[:80] if str(row["RC2_Error"]).upper() not in ("NA", "NAN") else ""
                print(f"    {row['TC_ID']:<10} {row['Testcase Name']:<55}{src}")
                if error_snip:
                    print(f"{'':>14}Error: {error_snip}")

    if not rc2_known.empty:
        print(f"\n{'─'*72}")
        print(f"  KNOWN ERRORS IN B#{rc2_label}  (failures with linked Jira)")
        print(f"{'─'*72}")
        for svc in sorted(rc2_known["Service"].unique()):
            svc_kn = rc2_known[rc2_known["Service"] == svc].sort_values("TC_ID")
            print(f"\n  [{svc}]  ({len(svc_kn)} known)")
            for _, row in svc_kn.iterrows():
                src = ""
                if row["RC1_Result"] == "PASS":
                    src = " (REGRESSION)"
                elif row["RC1_Result"] == "FAIL":
                    src = " (PERSISTENT)"
                elif row["RC1_Result"] == "NOT_PRESENT":
                    src = " (NEW TC)"
                linked = str(row["RC2_Linked"])
                print(f"    {row['TC_ID']:<10} {row['Testcase Name']:<55}{src}")
                print(f"{'':>14}Linked: {linked}")

    # ---- Fixed tests detail ----
    if not fixed.empty:
        print(f"\n{'─'*72}")
        print(f"  FIXED TESTS  (FAIL in B#{rc1_label} → PASS in B#{rc2_label})")
        print(f"{'─'*72}")
        for svc in sorted(fixed["Service"].unique()):
            svc_fix = fixed[fixed["Service"] == svc].sort_values("TC_ID")
            print(f"\n  [{svc}]  ({len(svc_fix)} fixed)")
            for _, row in svc_fix.iterrows():
                print(f"    {row['TC_ID']:<10} {row['Testcase Name']}")

    # ================================================================
    # CSV OUTPUT
    # ================================================================
    timestamp = pd.Timestamp.now().strftime("%Y%m%d_%H%M%S")
    prefix = f"{friendly}_{rc1_label}_vs_{rc2_label}"

    # --- Regressions CSV ---
    if not regressions.empty:
        reg_out = regressions[[
            "TC_ID", "Testcase Name", "Service",
            "RC1_Result", "RC2_Result", "RC2_Error", "RC2_Linked"
        ]].copy()
        reg_out["Error_Type"] = reg_out["RC2_Linked"].apply(
            lambda v: "KNOWN" if is_linked(v) else "UNKNOWN"
        )
        reg_csv = os.path.join(output_dir, f"{prefix}_regressions_{timestamp}.csv")
        reg_out.sort_values(["Service", "TC_ID"]).to_csv(reg_csv, index=False)
        print(f"\n  📄 Regressions saved  → {reg_csv}")

    # --- All RC2 failures CSV ---
    if not rc2_all_fails.empty:
        fail_out = rc2_all_fails[[
            "TC_ID", "Testcase Name", "Service",
            "RC1_Result", "RC2_Result", "RC2_Error", "RC2_Linked"
        ]].copy()
        fail_out["Error_Type"] = fail_out["RC2_Linked"].apply(
            lambda v: "KNOWN" if is_linked(v) else "UNKNOWN"
        )
        fail_out["Category"] = fail_out.apply(
            lambda r: "REGRESSION" if r["RC1_Result"] == "PASS"
            else "PERSISTENT" if r["RC1_Result"] == "FAIL"
            else "NEW_TC",
            axis=1,
        )
        fail_csv = os.path.join(output_dir, f"{prefix}_all_failures_{timestamp}.csv")
        fail_out.sort_values(["Service", "TC_ID"]).to_csv(fail_csv, index=False)
        print(f"  📄 All RC2 failures   → {fail_csv}")

    # --- Full comparison CSV ---
    full_out = merged[[
        "TC_ID", "Testcase Name", "Service",
        "RC1_Result", "RC2_Result", "RC2_Error", "RC2_Linked", "_merge"
    ]].copy()
    full_out["_merge"] = full_out["_merge"].map({
        "both": "COMMON",
        "left_only": f"ONLY_IN_B{rc1_label}",
        "right_only": f"ONLY_IN_B{rc2_label}",
    })
    full_out.rename(columns={"_merge": "Presence"}, inplace=True)
    full_csv = os.path.join(output_dir, f"{prefix}_full_comparison_{timestamp}.csv")
    full_out.sort_values(["Service", "TC_ID"]).to_csv(full_csv, index=False)
    print(f"  📄 Full comparison    → {full_csv}")

    # --- Service summary CSV ---
    svc_compare_rows = []
    for svc in all_services:
        r1 = svc1[svc1["Service Name"] == svc]
        r2 = svc2[svc2["Service Name"] == svc]
        row = {
            "Service": svc,
            f"B{rc1_label}_Pass": int(r1["Pass"].iloc[0]) if not r1.empty else 0,
            f"B{rc1_label}_Total": int(r1["Total TC"].iloc[0]) if not r1.empty else 0,
            f"B{rc1_label}_Fail": int(r1["Fail"].iloc[0]) if not r1.empty else 0,
            f"B{rc2_label}_Pass": int(r2["Pass"].iloc[0]) if not r2.empty else 0,
            f"B{rc2_label}_Total": int(r2["Total TC"].iloc[0]) if not r2.empty else 0,
            f"B{rc2_label}_Fail": int(r2["Fail"].iloc[0]) if not r2.empty else 0,
            "Regressions": len(regressions[regressions["Service"] == svc]),
            "Fixed": len(fixed[fixed["Service"] == svc]),
        }
        p1 = row[f"B{rc1_label}_Pass"]
        t1 = row[f"B{rc1_label}_Total"]
        p2 = row[f"B{rc2_label}_Pass"]
        t2 = row[f"B{rc2_label}_Total"]
        row[f"B{rc1_label}_Pass%"] = round(p1 / t1 * 100, 2) if t1 > 0 else 0
        row[f"B{rc2_label}_Pass%"] = round(p2 / t2 * 100, 2) if t2 > 0 else 0
        row["Pass%_Delta"] = round(row[f"B{rc2_label}_Pass%"] - row[f"B{rc1_label}_Pass%"], 2)
        svc_compare_rows.append(row)

    svc_csv = os.path.join(output_dir, f"{prefix}_service_summary_{timestamp}.csv")
    pd.DataFrame(svc_compare_rows).to_csv(svc_csv, index=False)
    print(f"  📄 Service summary    → {svc_csv}")

    print(f"\n{'='*72}\n")


if __name__ == "__main__":
    main()
