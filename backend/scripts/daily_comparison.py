#!/usr/bin/env python3
"""
Daily DAST Comparison — Compare previous vs current day DAST reports.

Extracts test case results from both reports, identifies regressions, fixes,
stable passes, new/removed tests, and maintains a per-device daily stats CSV
with 5-day trend analysis.
"""

import argparse
import os
import sys

import pandas as pd
from datetime import date
from wcwidth import wcswidth

# =====================================================================
# SCRIPT METADATA — consumed by Perda script runner
# =====================================================================

# Relative paths resolved by the script runner from this file's location
SCRIPT_CWD = "../../../report_comparision_tool"
SCRIPT_OUTPUTS = "../../../report_comparision_tool/output/daily_stats"

SCRIPT_ARGS = [
    {
        "name": "device",
        "type": "string",
        "description": "Device name (e.g. D-430, D-210_UK, D-450_IN, D-450_US)",
        "default": "D-430",
        "required": True,
    },
    {
        "name": "prev_version",
        "type": "string",
        "description": "Previous build version (folder name under input/previous/{device}/)",
        "default": "6.14.rc.1",
        "required": True,
    },
    {
        "name": "curr_version",
        "type": "string",
        "description": "Current build version (folder name under input/current/{device}/)",
        "default": "1072",
        "required": True,
    },
    {
        "name": "append_history",
        "type": "bool",
        "description": "Automatically append today's data to the history CSV",
        "default": "true",
        "required": False,
    },
]

# =====================================================================
# SERVICES LIST
# =====================================================================

SERVICES = [
    "BAGHEERA",
    "BAGHEERA-DISABLED-PRIVACY",
    "BAGHEERA-ENHANCED-PRIVACY",
    "BAGHEERA-OFFDUTY-PRIVACY",
    "BAGHEERA-REGULAR-PRIVACY",
    "POWER-MON",
    "POWER-MON-CRANKLOW",
    "POWER-MON-LPM",
    "CIRCBUFF",
    "SVC",
    "DIAGNOSTIC",
    "SPEED",
    "CONNECTIONMANAGER",
    "TIMESYNC",
    "WIFI",
]


# =====================================================================
# DISPLAY HELPERS
# =====================================================================


def pad(text, width):
    display_width = wcswidth(text)
    if display_width < 0:
        display_width = len(text)
    if display_width < width:
        return text + " " * (width - display_width)
    return text


def arrow(curr, prev):
    if curr > prev:
        return "↑"
    elif curr < prev:
        return "↓"
    else:
        return "→"


# =====================================================================
# EXTRACT FUNCTIONS
# =====================================================================


def extract_required_columns(html_file):
    tables = pd.read_html(html_file)[4:]
    collected = []
    for df in tables:
        df.columns = df.columns.str.strip()
        required_cols = {"Testcase Name", "Result", "Error Data", "Linked Issues"}
        if required_cols.issubset(df.columns):
            temp = df[["Testcase Name", "Result", "Error Data", "Linked Issues"]].copy()
            collected.append(temp)
    if collected:
        return pd.concat(collected, ignore_index=True)
    else:
        return pd.DataFrame(columns=["Testcase Name", "Result", "Error Data", "Linked Issues"])


# =====================================================================
# MAIN
# =====================================================================


def main():
    parser = argparse.ArgumentParser(description="Daily DAST Comparison Tool")
    parser.add_argument("--device", type=str, required=True, help="Device name")
    parser.add_argument("--prev_version", type=str, required=True, help="Previous build version folder")
    parser.add_argument("--curr_version", type=str, required=True, help="Current build version folder")
    parser.add_argument("--append_history", action="store_true", default=False,
                        help="Append today's data to history CSV")
    args = parser.parse_args()

    device = args.device
    prev_file = f"input/previous/{device}/{args.prev_version}/DAST Report.html"
    curr_file = f"input/current/{device}/{args.curr_version}/DAST Report.html"

    # Validate inputs
    if not os.path.isfile(prev_file):
        sys.exit(f"❌ Previous report not found: {prev_file}")
    if not os.path.isfile(curr_file):
        sys.exit(f"❌ Current report not found: {curr_file}")

    print(f"\n{'='*72}")
    print(f"  Daily Comparison: {device}")
    print(f"{'='*72}")
    print(f"  Previous: {prev_file}")
    print(f"  Current:  {curr_file}\n")

    # -------- READ SUMMARY TABLE (TABLE 0) --------
    summary_df = pd.read_html(curr_file)[0]
    summary_df.columns = summary_df.columns.str.strip()

    # -------- READ START TIMESTAMP (TABLE 1) --------
    timestamp_df = pd.read_html(curr_file)[1]
    timestamp_df.columns = timestamp_df.columns.str.strip()
    raw_timestamp = timestamp_df["Start Timestamp"].iloc[0]
    run_date = pd.to_datetime(raw_timestamp).strftime("%d-%m-%Y")

    # -------- READ SERVICE SUMMARY TABLE (TABLE 2) --------
    service_df = pd.read_html(curr_file)[2]
    service_df.columns = service_df.columns.str.strip()
    service_df.rename(columns={"Service Name": "Service", "Pass%": "Pass_Percent"}, inplace=True)
    service_df["Pass"] = pd.to_numeric(service_df["Pass"], errors="coerce").fillna(0).astype(int)
    service_df["Pass_Percent"] = (
        service_df["Pass_Percent"].astype(str).str.replace("%", "", regex=False)
    )
    service_df["Pass_Percent"] = pd.to_numeric(service_df["Pass_Percent"], errors="coerce").fillna(0)
    service_df["Total"] = service_df.apply(
        lambda row: int(round(row["Pass"] / (row["Pass_Percent"] / 100)))
        if row["Pass_Percent"] > 0 else 0,
        axis=1
    )

    service_pass_counts = {}
    service_total_counts = {}
    for service in SERVICES:
        row = service_df[service_df["Service"].str.strip().str.upper() == service.upper()]
        if not row.empty:
            service_pass_counts[service] = int(row["Pass"].iloc[0])
            service_total_counts[service] = int(row["Total"].iloc[0])
        else:
            service_pass_counts[service] = 0
            service_total_counts[service] = 0

    # -------- SUMMARY PERCENTAGES --------
    pass_count = int(
        summary_df.loc[summary_df["Result"].str.contains("Pass", case=False), "Test Cases"].values[0]
    )
    known_failure_count = int(
        summary_df.loc[summary_df["Result"].str.contains("Known Failure", case=False), "Test Cases"].values[1]
    )
    unknown_failure_count = int(
        summary_df.loc[summary_df["Result"].str.contains("Unknown Failure", case=False), "Test Cases"].values[0]
    )
    not_executed_count = int(
        summary_df.loc[summary_df["Result"].str.contains("Not Executed", case=False), "Test Cases"].values[0]
    )
    total_summary = pass_count + known_failure_count + unknown_failure_count + not_executed_count
    pass_pct_summary = (pass_count / total_summary * 100) if total_summary else 0
    known_pct_summary = (known_failure_count / total_summary * 100) if total_summary else 0
    unknown_pct_summary = (unknown_failure_count / total_summary * 100) if total_summary else 0

    # -------- EXTRACT & MERGE TESTCASES --------
    prev_all_df = extract_required_columns(prev_file)
    curr_all_df = extract_required_columns(curr_file)

    prev_all_df = prev_all_df.rename(columns={
        "Result": "Prev_Result", "Error Data": "Prev_Error", "Linked Issues": "Prev_Linked_Issues"
    })
    curr_all_df = curr_all_df.rename(columns={
        "Result": "Curr_Result", "Error Data": "Curr_Error", "Linked Issues": "Curr_Linked_Issues"
    })

    merged_df = pd.merge(prev_all_df, curr_all_df, on="Testcase Name", how="outer", indicator=True)
    merged_df["Prev_Result"] = merged_df["Prev_Result"].astype(str).str.upper().str.strip()
    merged_df["Curr_Result"] = merged_df["Curr_Result"].astype(str).str.upper().str.strip()

    regressions_df = merged_df[
        (merged_df["Prev_Result"] == "PASS") & (merged_df["Curr_Result"] == "FAIL")
    ]
    reg_unknown_df = regressions_df[
        regressions_df["Curr_Linked_Issues"].isna()
        | (regressions_df["Curr_Linked_Issues"].astype(str).str.strip() == "")
        | (regressions_df["Curr_Linked_Issues"].astype(str).str.upper() == "NA")
    ]
    fixed_df = merged_df[
        (merged_df["Prev_Result"] == "FAIL") & (merged_df["Curr_Result"] == "PASS")
    ]
    fail_both_df = merged_df[
        (merged_df["Prev_Result"] == "FAIL") & (merged_df["Curr_Result"] == "FAIL")
    ]
    pass_both_df = merged_df[
        (merged_df["Prev_Result"] == "PASS") & (merged_df["Curr_Result"] == "PASS")
    ]
    new_tests = merged_df[merged_df["_merge"] == "right_only"]
    removed_tests = merged_df[merged_df["_merge"] == "left_only"]
    new_pass_df = new_tests[new_tests["Curr_Result"] == "PASS"]
    new_fail_df = new_tests[new_tests["Curr_Result"] == "FAIL"]
    new_na_df = new_tests[new_tests["Curr_Result"] == "NA"]
    new_ne_df = new_tests[new_tests["Curr_Result"] == "NE"]

    # -------- STATS --------
    total_considered = len(merged_df)
    daily_row = {
        "Date": run_date,
        "Total": total_considered,
        "Pass_Pct_Summary": pass_pct_summary,
        "KnownFail_Pct_Summary": known_pct_summary,
        "UnknownFail_Pct_Summary": unknown_pct_summary,
        "Unknown_Failures": unknown_failure_count,
        "Known_Failures": known_failure_count,
        "Regressions": len(regressions_df),
        "Regression_Unknown": len(reg_unknown_df),
        "Fail_Both": len(fail_both_df),
        "Fixed": len(fixed_df),
        "Stable": len(pass_both_df),
        "New_Testcases": len(new_tests),
        "New_Pass": len(new_pass_df),
        "New_Fail": len(new_fail_df),
        "New_NA": len(new_na_df),
        "New_NE": len(new_ne_df),
        "Removed_Testcases": len(removed_tests),
    }

    for service in SERVICES:
        daily_row[f"{service}_Pass"] = service_pass_counts[service]
        daily_row[f"{service}_Total"] = service_total_counts[service]

    daily_df = pd.DataFrame([daily_row])
    os.makedirs("output/daily_stats", exist_ok=True)
    stats_file = f"output/daily_stats/{device}.csv"

    if os.path.exists(stats_file) and os.path.getsize(stats_file) > 0:
        history_df = pd.read_csv(stats_file)
    else:
        history_df = pd.DataFrame(columns=daily_df.columns)

    for service in SERVICES:
        for suffix in ["_Pass", "_Total"]:
            col = f"{service}{suffix}"
            if col not in history_df.columns:
                history_df[col] = 0

    # -------- APPEND HISTORY --------
    if args.append_history:
        print("✅ Appending today's data to history")
        history_df = pd.concat([history_df, daily_df], ignore_index=True)
        history_df.to_csv(stats_file, index=False)
    else:
        print("ℹ️ History NOT modified (not appending today's data)")

    # -------- DAILY SUMMARY --------
    print(f"\n{'─'*72}")
    print(f"  DAILY SUMMARY — {device} — {run_date}")
    print(f"{'─'*72}")
    print(f"  Total test cases considered : {total_considered}")
    print(f"  Stable (pass → pass)        : {len(pass_both_df)}")
    print(f"  Fixed (fail → pass)         : {len(fixed_df)}")
    print(f"  Regressions (pass → fail)   : {len(regressions_df)}")
    print(f"    └─ Unknown regressions    : {len(reg_unknown_df)}")
    print(f"  Persistent (fail → fail)    : {len(fail_both_df)}")
    print(f"  New test cases              : {len(new_tests)}")
    print(f"  Removed test cases          : {len(removed_tests)}")
    print(f"\n  Summary Pass %              : {pass_pct_summary:.2f}%")
    print(f"  Known Failure %             : {known_pct_summary:.2f}%")
    print(f"  Unknown Failure %           : {unknown_pct_summary:.2f}%")

    # -------- 5 DAY TREND --------
    last5 = history_df.tail(5).iloc[::-1].reset_index(drop=True)

    if len(last5) > 0:
        METRIC_WIDTH = 32
        CELL_WIDTH = 16

        print(f"\n{'='*72}")
        print("  5 DAY TREND (DELTA VIEW)")
        print(f"{'='*72}\n")

        dates = list(last5["Date"].astype(str))
        header = f"{'Metric':<{METRIC_WIDTH}}" + "".join(f"{d:>{CELL_WIDTH}}" for d in dates)
        print(header)
        print("-" * len(header))

        totals = [last5.loc[i, "Total"] for i in range(len(last5))]

        def print_pct_row(name, values):
            name_padded = pad(name, METRIC_WIDTH)
            row = name_padded
            for i in range(len(values)):
                cell = f"{values[i]:.2f}%"
                if i == len(values) - 1:
                    row += f"{cell:>{CELL_WIDTH}}"
                else:
                    row += f"{cell:>{CELL_WIDTH-1}}{arrow(values[i], values[i+1])}"
            print(row)

        def print_row(name, values):
            name_padded = pad(name, METRIC_WIDTH)
            row = name_padded
            for i in range(len(values)):
                pct_val = (values[i] / totals[i] * 100) if totals[i] > 0 else 0
                cell = f"{values[i]} ({pct_val:.2f}%)"
                if i == len(values) - 1:
                    row += f"{cell:>{CELL_WIDTH}}"
                else:
                    row += f"{cell:>{CELL_WIDTH-1}}{arrow(values[i], values[i+1])}"
            print(row)

        print("\n---- SUMMARY PASS/FAIL % ----")
        pass_pct_vals = [last5.loc[i, "Pass_Pct_Summary"] for i in range(len(last5))]
        known_pct_vals = [last5.loc[i, "KnownFail_Pct_Summary"] for i in range(len(last5))]
        unknown_pct_vals = [last5.loc[i, "UnknownFail_Pct_Summary"] for i in range(len(last5))]
        print_pct_row("✅ Pass % (summary)", pass_pct_vals)
        print_pct_row("⚠️ Known % (summary)", known_pct_vals)
        print_pct_row("🚨 Unknown % (summary)", unknown_pct_vals)

        print("\n---- PASSED ----")
        stable_vals = [last5.loc[i, "Stable"] for i in range(len(last5))]
        fixed_vals = [last5.loc[i, "Fixed"] for i in range(len(last5))]
        print_row("🟢 Stable (pass -> pass)", stable_vals)
        print_row("🔧 Fixed (fail -> pass)", fixed_vals)

        print("\n---- FAILURE ----")
        total_fail_vals = [last5.loc[i, "Unknown_Failures"] + last5.loc[i, "Known_Failures"] for i in range(len(last5))]
        unknown_vals = [last5.loc[i, "Unknown_Failures"] for i in range(len(last5))]
        known_vals = [last5.loc[i, "Known_Failures"] for i in range(len(last5))]
        reg_vals = [last5.loc[i, "Regressions"] for i in range(len(last5))]
        reg_unknown_vals = [last5.loc[i, "Regression_Unknown"] for i in range(len(last5))]
        exist_vals = [last5.loc[i, "Fail_Both"] for i in range(len(last5))]
        print_row("❌ Total Failures", total_fail_vals)
        print_row("🚨 Unknown", unknown_vals)
        print_row("⚠️  Known", known_vals)
        print_row("🔁 Regressions (pass -> fail)", reg_vals)
        print_row("❗ Reg Unknown (pass -> fail)", reg_unknown_vals)
        print_row("⏳ Existing (fail -> fail)", exist_vals)

        print("\n---- TEST SUITE CHANGE ----")
        new_total_vals = [last5.loc[i, "New_Testcases"] for i in range(len(last5))]
        new_pass_vals = [last5.loc[i, "New_Pass"] for i in range(len(last5))]
        new_fail_vals = [last5.loc[i, "New_Fail"] for i in range(len(last5))]
        new_na_vals = [last5.loc[i, "New_NA"] for i in range(len(last5))]
        new_ne_vals = [last5.loc[i, "New_NE"] for i in range(len(last5))]
        removed_vals = [last5.loc[i, "Removed_Testcases"] for i in range(len(last5))]
        print_row("🆕 Total New", new_total_vals)
        print_row("✅ New Passed", new_pass_vals)
        print_row("❌ New Failed", new_fail_vals)
        print_row("🟡 New NA", new_na_vals)
        print_row("⚪ New NE", new_ne_vals)
        print_row("🗑️  Removed", removed_vals)

        print("\n---- SERVICE PASS RATE ----")
        for service in SERVICES:
            pass_vals = [last5.loc[i, f"{service}_Pass"] for i in range(len(last5))]
            total_vals_svc = [last5.loc[i, f"{service}_Total"] for i in range(len(last5))]
            name_padded = pad(service, METRIC_WIDTH)
            row = name_padded
            for i in range(len(pass_vals)):
                total = total_vals_svc[i]
                pct_val = (pass_vals[i] / total * 100) if total > 0 else 0
                cell = f"{pass_vals[i]} ({pct_val:.2f}%)"
                if i == len(pass_vals) - 1:
                    row += f"{cell:>{CELL_WIDTH}}"
                else:
                    row += f"{cell:>{CELL_WIDTH-1}}{arrow(pass_vals[i], pass_vals[i+1])}"
            print(row)

        print(f"\n{'='*72}")
    else:
        print("\nNo historical data available for trend analysis.")

    print("\nDone.")


if __name__ == "__main__":
    main()
