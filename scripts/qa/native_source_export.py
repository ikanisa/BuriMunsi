#!/usr/bin/env python3
"""Export exact local native build inputs without ignored credentials or caches."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
ROOTS = ("lib/", "assets/", "licenses/", "android/", "ios/", "third_party/", "test/", "integration_test/", "tool/", "web/")
FILES = {"pubspec.yaml", "pubspec.lock", "analysis_options.yaml", ".metadata", ".fvmrc",
         "AGENTS.md", "scripts/qa/native_source_export.py", "scripts/qa/native_build_provenance.rb",
         "scripts/qa/native_artifact_metadata.py", "scripts/qa/native_build_config.py",
         "scripts/qa/client_diagnostic_identity.py",
         "scripts/supabase/deployment_profile.py", "contracts/deployment-profile.schema.json",
         "scripts/android_play_store_build.sh", "scripts/android_release_signing_preflight.sh",
         "scripts/ios_app_store_build.sh", "scripts/supply_chain/gradle_runtime_inventory.init.gradle"}
PRIVATE_NAMES = {"key.properties", "google-services.json", "GoogleService-Info.plist", "local.properties", "Generated.xcconfig", "flutter_export_environment.sh"}
_PRIVATE_SUFFIXES = {".jks", ".keystore", ".p12", ".pfx", ".p8", ".pem", ".key", ".mobileprovision"}
_REQUIRED_INPUTS = {
    "pubspec.yaml", "pubspec.lock", "lib/main.dart", "android/app/build.gradle.kts",
    "ios/Runner.xcodeproj/project.pbxproj", "scripts/qa/native_artifact_metadata.py",
    "scripts/qa/native_build_config.py", "scripts/qa/client_diagnostic_identity.py",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selected(name):
    path = Path(name)
    if path.name in PRIVATE_NAMES or path.suffix.lower() in _PRIVATE_SUFFIXES or path.name.startswith(".env"):
        return False
    return name in FILES or name.startswith(ROOTS)


def _source_fingerprints(root):
    listed = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root,
    )
    names = listed.decode().split("\0")
    fingerprints = {}
    for name in sorted(set(names)):
        if not name or not selected(name):
            continue
        source = root / name
        if not source.is_file():
            continue
        if root not in source.resolve().parents:
            raise ValueError("Native build source escapes checkout: " + name)
        if source.is_symlink():
            raise ValueError("Native build source must be a regular file: " + name)
        fingerprints[name] = digest(source)
    if not _REQUIRED_INPUTS <= fingerprints.keys():
        raise ValueError("Required native build input is absent")
    return fingerprints


def _copy_verified_sources(root, destination, fingerprints):
    destination.mkdir(parents=True)
    for name, sha in fingerprints.items():
        source = root / name
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        if digest(target) != sha or digest(source) != sha:
            raise ValueError("Native source changed during export: " + name)


def export(root, destination):
    root, destination = root.resolve(), destination.resolve()
    if destination == root or root in destination.parents:
        raise ValueError("Native source export must use an isolated directory outside the checkout")
    if destination.exists():
        raise ValueError("Native source export refuses to overwrite an existing directory")
    fingerprints = _source_fingerprints(root)
    _copy_verified_sources(root, destination, fingerprints)
    return {"kind": "isolated_native_source_export", "source_sha256": fingerprints,
            "source_file_count": len(fingerprints), "destination": str(destination),
            "ignored_files_copied": False, "private_provider_signing_inputs_copied": False,
            "scope": "Exact declared native build source roots, tests, public source, authority and production build callers; generated SDK bindings and build outputs are recorded separately"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    result = export(ROOT, args.destination)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"source_file_count": result["source_file_count"], "report": str(args.report)}))


if __name__ == "__main__":
    main()
