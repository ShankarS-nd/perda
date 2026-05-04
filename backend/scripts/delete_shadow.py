#!/usr/bin/env python3
"""
Delete IoT Device Shadows
==========================
Deletes the Classic Shadow and priority-shadow-vod named shadow
for a list of device IDs.

Always deletes BOTH:
  1. Classic Shadow (the default/unnamed shadow)
  2. priority-shadow-vod (named shadow)

Authentication:
  Uses the default AWS credentials available on the server
  (instance profile, environment variables, or ~/.aws/credentials).
  No SSO profile is required.
"""

import sys
import json
import subprocess

try:
    import boto3
    from botocore.exceptions import NoCredentialsError, ClientError
except ImportError:
    print("ERROR: boto3 is not installed. Run: pip install boto3", file=sys.stderr)
    sys.exit(1)


def ensure_aws_credentials() -> bool:
    """
    Check if valid AWS credentials are available (default credential chain).
    Returns True if credentials are valid, False otherwise.
    """
    print("🔑 Checking AWS credentials...")
    try:
        session = boto3.Session()
        sts = session.client("sts")
        identity = sts.get_caller_identity()
        print(f"  ✔ Credentials valid (Account: {identity['Account']})")
        return True
    except NoCredentialsError:
        print("  ⚠ No AWS credentials found.")
        print("    Ensure credentials are configured via environment variables,")
        print("    ~/.aws/credentials, or an instance profile.")
        return False
    except ClientError as e:
        print(f"  ⚠ AWS credential check failed: {e}")
        return False
    except Exception as e:
        print(f"  ⚠ Unexpected error checking credentials: {e}")
        return False

# =====================================================================
# SCRIPT METADATA — consumed by Perda script runner
# =====================================================================

SCRIPT_ARGS = [
    {
        "name": "region",
        "type": "string",
        "description": "AWS region where the IoT devices are registered (e.g. 'us-west-2')",
        "default": "us-west-2",
        "required": True,
    },
    {
        "name": "device_ids",
        "type": "string",
        "description": "Device serial numbers separated by commas, OR a group name: B2_US, K2_US, K1_US, B3_US, B3_IN, K2_IN, K1_UK, ALL",
        "required": True,
    },
]

# =====================================================================
# Preset device groups (quick selection reference)
# =====================================================================

DEVICE_GROUPS = {
    "B2_US": ["3633118425", "3633042251", "3633118764", "3633053124", "3633009572", "3633073885", "3633118314"],
    "K2_US": ["6603083402", "6603083306", "6603083417", "6603073901", "6603085697", "6603083308", "6603029208"],
    "K1_US": ["264130505", "264130576", "264067412", "264065431", "264067487", "264129998", "264067451"],
    "B3_US": ["103112400111", "103142400150", "103112400110", "103142400160", "103452403643", "103452403705", "103212400447"],
    "B3_IN": ["103062502272", "103062503140", "103062502237", "103062503146", "103062502313", "103062502262"],
    "K2_IN": ["6603083392", "6603083366", "6603083426", "6603083621", "6603075403", "6603083414", "6603022466"],
    "K1_UK": ["264130567", "264129228", "264130566", "264032054", "264115664", "264130581", "264031826"],
    "ALL":   [],  # populated below
}

# Build the ALL group from every other group
for _grp_devices in list(DEVICE_GROUPS.values()):
    DEVICE_GROUPS["ALL"].extend(_grp_devices)


# =====================================================================
# Main logic
# =====================================================================

def parse_device_ids(raw: str) -> list[str]:
    """Parse comma/newline/space separated device IDs, stripping whitespace."""
    # Check if it's a preset group name
    upper = raw.strip().upper()
    if upper in DEVICE_GROUPS:
        print(f"📋 Using preset device group: {upper} ({len(DEVICE_GROUPS[upper])} devices)")
        return DEVICE_GROUPS[upper]

    # Otherwise parse as list
    ids = []
    for part in raw.replace("\n", ",").replace(" ", ",").split(","):
        part = part.strip()
        if part:
            ids.append(part)
    return ids


def delete_shadows(
    region: str,
    device_ids: list[str],
):
    """Delete Classic Shadow and priority-shadow-vod for the given device IDs (staging)."""

    SHADOW_NAME = "priority-shadow-vod"

    print(f"🌍 Region: {region}")
    print(f"📦 Devices: {len(device_ids)}")
    print(f"🏷️  Environment: Staging (staging- prefix applied)")
    print(f"🗑️  Shadows to delete: Classic Shadow, {SHADOW_NAME}")
    print("=" * 60)

    # Verify AWS credentials are available
    if not ensure_aws_credentials():
        print("\n❌ Cannot proceed without valid AWS credentials.", file=sys.stderr)
        sys.exit(1)

    try:
        session = boto3.Session()
        client = session.client('iot-data', region_name=region)
    except Exception as e:
        print(f"\n❌ Failed to create AWS session: {e}", file=sys.stderr)
        sys.exit(1)

    # Always staging
    thing_names = [f"staging-{d}" for d in device_ids]

    # Track results
    results = {
        "total": len(thing_names),
        "classic_deleted": 0,
        "classic_failed": 0,
        "named_deleted": 0,
        "named_failed": 0,
    }

    for thing_name in thing_names:
        print(f"\n🗑️  Deleting shadows for: {thing_name}")

        # 1. Delete Classic Shadow
        try:
            client.delete_thing_shadow(thingName=thing_name)
            print(f"  ✔ Classic Shadow deleted")
            results["classic_deleted"] += 1
        except client.exceptions.ResourceNotFoundException:
            print(f"  ⚠ Classic Shadow not found (already clean)")
            results["classic_failed"] += 1
        except Exception as e:
            print(f"  ❌ Classic Shadow delete failed: {str(e)}")
            results["classic_failed"] += 1

        # 2. Delete priority-shadow-vod
        try:
            client.delete_thing_shadow(
                thingName=thing_name,
                shadowName=SHADOW_NAME,
            )
            print(f"  ✔ {SHADOW_NAME} deleted")
            results["named_deleted"] += 1
        except client.exceptions.ResourceNotFoundException:
            print(f"  ⚠ {SHADOW_NAME} not found (already clean)")
            results["named_failed"] += 1
        except Exception as e:
            print(f"  ❌ {SHADOW_NAME} delete failed: {str(e)}")
            results["named_failed"] += 1

    # Summary
    print("\n" + "=" * 60)
    print("📊 SUMMARY")
    print("=" * 60)
    print(f"  Total devices processed: {results['total']}")
    print(f"  Classic Shadow deleted:      {results['classic_deleted']}/{results['total']}")
    print(f"  priority-shadow-vod deleted: {results['named_deleted']}/{results['total']}")

    failed = results["classic_failed"] + results["named_failed"]
    if failed == 0:
        print("\n✅ All shadow deletions completed successfully!")
    else:
        print(f"\n⚠️  Some operations had issues ({failed} failures/not-found)")

    return results


# =====================================================================
# CLI entry point
# =====================================================================

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Delete Classic Shadow and priority-shadow-vod from IoT devices")
    parser.add_argument("--region", type=str, default="us-west-2",
                        help="AWS region where devices are registered")
    parser.add_argument("--device_ids", type=str, required=True,
                        help="Comma-separated device serial numbers, or a group name: B2_US, K2_US, K1_US, B3_US, B3_IN, K2_IN, K1_UK, ALL")

    args = parser.parse_args()

    # Parse device list
    devices = parse_device_ids(args.device_ids)

    if not devices:
        print("❌ No device IDs provided!", file=sys.stderr)
        sys.exit(1)

    print(f"\n{'='*60}")
    print("  AWS IoT Shadow Deletion Tool")
    print("  Deletes: Classic Shadow + priority-shadow-vod")
    print(f"{'='*60}\n")

    delete_shadows(
        region=args.region,
        device_ids=devices,
    )
