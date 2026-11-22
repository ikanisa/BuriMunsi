#!/usr/bin/env python3
"""Public release configuration only. Never accepts database/provider secrets."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

try:
    from .deployment_profile import FORMAT, resolve_profile, public_profile_defines
except ImportError:
    from deployment_profile import FORMAT, resolve_profile, public_profile_defines

PROJECT = "rrlduytparvsjfmegalh"
PROJECT_ORIGIN = f"https://{PROJECT}.supabase.co"
BURIMUNSI_ADMIN_ORIGIN = "https://burimunsi-admin.ikanisa.com"
BURIMUNSI_ADMIN_PROFILE_ID = "burimunsi-admin-production"
BASELINE = "20261020134444_collect_curated_platform_baseline.sql"


def burimunsi_admin_profile() -> dict[str, str]:
    return {
        "format": FORMAT,
        "mode": "managed",
        "environment": "production",
        "supabase_origin": PROJECT_ORIGIN,
        "id": BURIMUNSI_ADMIN_PROFILE_ID,
        "admin_origin": BURIMUNSI_ADMIN_ORIGIN,
        "member_api_origin": BURIMUNSI_ADMIN_ORIGIN,
        "public_origin": BURIMUNSI_ADMIN_ORIGIN,
        "google_callback_origin": BURIMUNSI_ADMIN_ORIGIN,
    }


def migration_chain(root: Path) -> list[dict[str, str]]:
    folder = root / 'supabase/migrations'
    files = sorted(path for path in folder.iterdir()
                   if re.fullmatch(r'\d{14}_[a-z0-9_]+\.sql', path.name))
    if not files or files[0].name != BASELINE or any(path.is_symlink() or not path.is_file() or not path.read_bytes().strip() for path in files):
        raise ValueError('Expected the complete curated Supabase migration chain')
    return [{'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in files]

def origin(value: str) -> str:
    parsed = urlsplit(value)
    if (value != value.strip() or parsed.scheme != "https" or not parsed.hostname
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Public release URLs must be HTTPS origins")
    return f"https://{parsed.hostname}"

def configuration(env: dict[str, str], root: Path) -> tuple[dict, dict]:
    profile = resolve_profile(env)
    if profile != burimunsi_admin_profile():
        raise ValueError("BuriMunsi Admin requires its exact production deployment profile")
    if env.get("COLLECT_BACKEND", "supabase") != "supabase":
        raise ValueError("BuriMunsi Admin requires the Supabase backend")
    if env.get("APP_ENVIRONMENT", "production") != "production":
        raise ValueError("Admin environment must match its deployment profile")
    if env.get("SUPABASE_AUTH_ISSUER", PROJECT_ORIGIN + "/auth/v1") != PROJECT_ORIGIN + "/auth/v1":
        raise ValueError("Admin Auth issuer must use the nominated Supabase origin")
    frontend = {name: origin(env.get(name, BURIMUNSI_ADMIN_ORIGIN)) for name in (
        "APP_PUBLIC_URL", "ADMIN_APP_URL", "SUPABASE_API_URL", "SUPABASE_ADMIN_API_URL")}
    if set(frontend.values()) != {BURIMUNSI_ADMIN_ORIGIN}:
        raise ValueError("BuriMunsi Admin requires its own same-origin transport")
    defines = {**frontend, "COLLECT_BACKEND": "supabase", "APP_ENVIRONMENT": "production",
               **public_profile_defines(env)}
    defines.update({"AUTH_CAPTCHA_ENABLED": "false", "AUTH_CAPTCHA_PROVIDER": "",
                    "AUTH_CAPTCHA_SITE_KEY": ""})
    if env.get("GOOGLE_AUTH_ENABLED", "false") != "false":
        raise ValueError("BuriMunsi Admin uses mobile number and passcode")
    defines["GOOGLE_AUTH_ENABLED"] = "false"
    key = env.get("SUPABASE_PUBLISHABLE_KEY", "")
    project = origin(env.get("SUPABASE_URL", PROJECT_ORIGIN))
    if project != PROJECT_ORIGIN:
        raise ValueError("BuriMunsi Admin requires the nominated project")
    if not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{10,300}", key):
        raise ValueError("Admin release requires a public Supabase publishable key")
    migration = root / "supabase/migrations" / BASELINE
    data = migration.read_bytes()
    if not data.strip():
        raise ValueError("Curated Supabase migration is empty")
    defines.update({"SUPABASE_URL": project, "SUPABASE_PUBLISHABLE_KEY": key})
    metadata = {
        "backend": "supabase",
        "notifications": "provider_configuration_required",
        "operating_actions_available": False,
        "operational_migration_complete": False,
        "financial_model": "canonical_evidence_ledger",
        "financial_contract_version": 2,
        "provider_settlement_available": False,
        "authentication": "burimunsi_phone_passcode_cookie",
        "data_strategy": "preserve_existing_source",
        "legacy_data_import_required": True,
        "minimum_core_schema_migration": BASELINE,
        "supabase_project_ref": PROJECT,
        "supabase_schema_sha256": hashlib.sha256(data).hexdigest(),
        "admin_transport": "same_origin_static_proxy",
        "admin_origin": frontend["ADMIN_APP_URL"],
        "api_origin": frontend["SUPABASE_API_URL"],
        "admin_api_origin": frontend["SUPABASE_ADMIN_API_URL"],
        "supabase_qualification_complete": False,
    }
    metadata.update({"deployment_profile": profile,
                     "deployment_profile_sha256": defines["COLLECT_DEPLOYMENT_PROFILE_SHA256"],
                     "supabase_hosting": profile["mode"],
                     "supabase_auth_issuer": defines["SUPABASE_AUTH_ISSUER"]})
    chain = migration_chain(root)
    metadata.update({'supabase_migrations': chain,
                     'supabase_migration_chain_sha256': hashlib.sha256(json.dumps(chain, sort_keys=True, separators=(',', ':')).encode()).hexdigest()})
    return defines, metadata
