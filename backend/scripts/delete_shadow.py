#!/usr/bin/env python3
"""
Delete IoT Device Shadows
==========================
Deletes AWS IoT classic and named shadows for a list of device IDs.

Supports:
  - Custom AWS profile selection
  - Configurable region
  - Optional "staging-" prefix on device IDs
  - Configurable named shadow name
  - Comma-separated or newline-separated device ID input

Authentication:
  Requires a valid AWS SSO profile configured locally.
"""

import sys
import json

try:
    import boto3
except ImportError:
    print("ERROR: boto3 is not installed. Run: pip install boto3", file=sys.stderr)
    sys.exit(1)

# =====================================================================
# SCRIPT METADATA — consumed by Perda script runner
# =====================================================================

SCRIPT_ARGS = [
    {
        "name": "profile_name",
        "type": "string",
        "description": "AWS CLI profile name (e.g., 'ganesh', 'default')",
        "default": "ganesh",
        "required": True,
    },
    {
        "name": "region",
        "type": "string",
        "description": "AWS region for IoT (e.g., us-west-2, us-east-1)",
        "default": "us-west-2",
        "required": True,
    },
    {
        "name": "device_ids",
        "type": "string",
        "description": "Comma-separated device IDs (e.g., '3633042251,6603083402,264130505')",
        "required": True,
    },
    {
        "name": "shadow_name",
        "type": "string",
        "description": "Named shadow to delete (leave empty to skip named shadow deletion)",
        "default": "priority-shadow-vod",
        "required": False,
    },
    {
        "name": "add_staging_prefix",
        "type": "bool",
        "description": "Prepend 'staging-' to each device ID before deletion",
        "default": "true",
        "required": False,
    },
    {
        "name": "delete_classic",
        "type": "bool",
        "description": "Delete the classic (unnamed) shadow for each device",
        "default": "true",
        "required": False,
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
    profile_name: str,
    region: str,
    device_ids: list[str],
    shadow_name: str = "priority-shadow-vod",
    add_staging_prefix: bool = True,
    delete_classic: bool = True,
):
    """Delete classic and/or named shadows for the given device IDs."""

    print(f"🔧 AWS Profile: {profile_name}")
    print(f"🌍 Region: {region}")
    print(f"📦 Devices: {len(device_ids)}")
    print(f"🏷️  Staging prefix: {'Yes' if add_staging_prefix else 'No'}")
    print(f"🗑️  Delete classic shadow: {'Yes' if delete_classic else 'No'}")
    print(f"🗑️  Delete named shadow: {shadow_name if shadow_name else 'No'}")
    print("=" * 60)

    try:
        session = boto3.Session(profile_name=profile_name)
        client = session.client('iot-data', region_name=region)
    except Exception as e:
        print(f"\n❌ Failed to create AWS session: {e}", file=sys.stderr)
        sys.exit(1)

    # Apply prefix
    thing_names = [f"staging-{d}" for d in device_ids] if add_staging_prefix else device_ids

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

        # Delete Classic Shadow
        if delete_classic:
            try:
                client.delete_thing_shadow(thingName=thing_name)
                print(f"  ✔ Classic shadow deleted")
                results["classic_deleted"] += 1
            except client.exceptions.ResourceNotFoundException:
                print(f"  ⚠ Classic shadow not found (already clean)")
                results["classic_failed"] += 1
            except Exception as e:
                print(f"  ❌ Classic shadow delete failed: {str(e)}")
                results["classic_failed"] += 1

        # Delete Named Shadow
        if shadow_name:
            try:
                client.delete_thing_shadow(
                    thingName=thing_name,
                    shadowName=shadow_name,
                )
                print(f"  ✔ Named shadow '{shadow_name}' deleted")
                results["named_deleted"] += 1
            except client.exceptions.ResourceNotFoundException:
                print(f"  ⚠ Named shadow '{shadow_name}' not found (already clean)")
                results["named_failed"] += 1
            except Exception as e:
                print(f"  ❌ Named shadow '{shadow_name}' delete failed: {str(e)}")
                results["named_failed"] += 1

    # Summary
    print("\n" + "=" * 60)
    print("📊 SUMMARY")
    print("=" * 60)
    print(f"  Total devices processed: {results['total']}")
    if delete_classic:
        print(f"  Classic shadows deleted: {results['classic_deleted']}/{results['total']}")
    if shadow_name:
        print(f"  Named shadows deleted:   {results['named_deleted']}/{results['total']}")

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

    parser = argparse.ArgumentParser(description="Delete AWS IoT device shadows")
    parser.add_argument("--profile_name", type=str, default="ganesh",
                        help="AWS CLI profile name")
    parser.add_argument("--region", type=str, default="us-west-2",
                        help="AWS region")
    parser.add_argument("--device_ids", type=str, required=True,
                        help="Comma-separated device IDs or preset group name (B2_US, K2_US, K1_US, B3_US, B3_IN, K2_IN, K1_UK, ALL)")
    parser.add_argument("--shadow_name", type=str, default="priority-shadow-vod",
                        help="Named shadow to delete (empty to skip)")
    parser.add_argument("--add_staging_prefix", type=str, default="true",
                        help="Prepend 'staging-' to device IDs (true/false)")
    parser.add_argument("--delete_classic", type=str, default="true",
                        help="Delete classic shadow (true/false)")

    args = parser.parse_args()

    # Parse boolean args
    staging = args.add_staging_prefix.lower() in ("true", "1", "yes")
    classic = args.delete_classic.lower() in ("true", "1", "yes")

    # Parse device list
    devices = parse_device_ids(args.device_ids)

    if not devices:
        print("❌ No device IDs provided!", file=sys.stderr)
        sys.exit(1)

    print(f"\n{'='*60}")
    print("  AWS IoT Shadow Deletion Tool")
    print(f"{'='*60}\n")

    delete_shadows(
        profile_name=args.profile_name,
        region=args.region,
        device_ids=devices,
        shadow_name=args.shadow_name,
        add_staging_prefix=staging,
        delete_classic=classic,
    )
