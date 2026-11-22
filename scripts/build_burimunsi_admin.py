#!/usr/bin/env python3
"""Build the dedicated BuriMunsi Admin with its public release identity."""

import argparse
import os
from pathlib import Path

from supabase.admin_build_config import burimunsi_admin_profile
from supabase.deployment_profile import canonical_profile, profile_sha256


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="production", choices=("production", "verify-ci"))
    args = parser.parse_args()
    profile = burimunsi_admin_profile()
    bindings = {
        "APP_ENVIRONMENT": profile["environment"],
        "COLLECT_BACKEND": "supabase",
        "COLLECT_DEPLOYMENT_PROFILE": canonical_profile(profile),
        "COLLECT_DEPLOYMENT_PROFILE_SHA256": profile_sha256(profile),
        "ADMIN_APP_URL": profile["admin_origin"],
        "APP_PUBLIC_URL": profile["public_origin"],
        "SUPABASE_URL": profile["supabase_origin"],
        "SUPABASE_AUTH_ISSUER": profile["supabase_origin"] + "/auth/v1",
        "SUPABASE_API_URL": profile["member_api_origin"],
        "SUPABASE_ADMIN_API_URL": profile["admin_origin"],
        "GOOGLE_AUTH_ENABLED": "false",
    }
    for name, expected in bindings.items():
        if name in os.environ and os.environ[name] != expected:
            raise SystemExit(f"Conflicting BuriMunsi Admin configuration for {name}")
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    os.execvpe("node", ["node", "admin-web/scripts/build-admin.mjs", args.action],
                os.environ | bindings)


if __name__ == "__main__":
    main()
