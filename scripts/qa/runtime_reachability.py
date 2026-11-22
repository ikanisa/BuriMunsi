#!/usr/bin/env python3
"""Conservative source reachability; never deletes files or approves a release.

Every quoted URI in multiline/conditional Dart import/export/part directives is
retained, including comments (false positives preserve rather than delete code).
Runtime entrypoints, test/tool roots, catalog-generated paths and implicit SDK
font use are separate. A result with unknown dynamic asset references requires
review; absence of a literal alone never authorizes deletion.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DIRECTIVE = re.compile(r"(?ms)^\s*(?:import|export|part)\s+(?!of\b)(.*?);")
URI = re.compile(r"['\"]([^'\"\n]+)['\"]")
RUNTIME_ROOTS = ["lib/main.dart", "lib/main_public.dart",
                 "lib/main_gateway.dart"]
SOURCE_DIRECTORIES = ("lib", "test", "integration_test", "tool", "third_party")
GROUP_COVER_CATALOG = "assets/group_covers/rwanda/catalog.v1.json"
REPORT_INPUTS = (
    "pubspec.yaml", "pubspec.lock", "analysis_options.yaml", GROUP_COVER_CATALOG,
    "scripts/qa/runtime_reachability.py",
)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_locations(root):
    return {path.relative_to(root).as_posix(): path for scope in SOURCE_DIRECTORIES
            for path in (root / scope).rglob("*.dart") if path.is_file()}


def source_dependencies(root, sources, texts):
    graph = {name: set() for name in sources}
    packages, missing = {}, []
    package_prefix = "package:collect_app/"
    for name, path in sources.items():
        for directive in DIRECTIVE.finditer(texts[name]):
            for uri in URI.findall(directive.group(1)):
                if uri.startswith("dart:"):
                    continue
                if uri.startswith("package:") and not uri.startswith(package_prefix):
                    packages.setdefault(uri[8:].split("/")[0], set()).add(name)
                    continue
                target = (root / "lib" / uri[len(package_prefix):]
                          if uri.startswith(package_prefix) else path.parent / uri)
                try:
                    relative = target.resolve().relative_to(root).as_posix()
                except ValueError:
                    missing.append({"source": name, "uri": uri, "reason": "outside_checkout"})
                    continue
                if relative in sources:
                    graph[name].add(relative)
                else:
                    missing.append({"source": name, "uri": uri, "reason": "missing_local_source"})
    return graph, packages, missing


def reachable(graph, roots):
    seen, pending = set(), list(roots)
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        pending.extend(graph.get(name, ()))
    return seen


def asset_declarations(root, flutter):
    bundled = {}
    for entry in flutter.get("assets", []):
        value = entry["path"] if isinstance(entry, dict) else entry
        path = root / value
        paths = sorted(p for p in path.rglob("*") if p.is_file()) if path.is_dir() else [path]
        for asset in paths:
            bundled.setdefault(asset.relative_to(root).as_posix(), []).append(value)
    for family in flutter.get("fonts", []):
        for font in family["fonts"]:
            bundled.setdefault(font["asset"], []).append("font:" + family["family"])
    for license_path in flutter.get("licenses", []):
        bundled.setdefault(license_path, []).append("license")
    return bundled


def asset_reachability(root, flutter, runtime, texts):
    bundled = asset_declarations(root, flutter)
    catalog = json.loads((root / GROUP_COVER_CATALOG).read_text())
    catalog_assets = {a["planned_files"][role]: a["id"] for a in catalog["assets"] for role in ["cover", "thumbnail"]}
    runtime_names = sorted(runtime)
    has_cover_loader = "lib/shared/models/collect_group_cover.dart" in runtime
    assets = []
    for path, declarations in sorted(bundled.items()):
        literal_sources = [name for name in runtime_names if path in texts[name]]
        roles = []
        if literal_sources:
            roles.append("runtime_literal")
        if path in catalog_assets and has_cover_loader:
            roles.append("runtime_catalog_allowlist")
        if any(d.startswith("font:") for d in declarations):
            roles.append("shared_font_declaration")
        if "license" in declarations:
            roles.append("font_license_declaration")
        target = root / path
        exists = target.is_file()
        assets.append({"path": path, "declarations": declarations, "exists": exists,
                       "sha256": sha(target) if exists else None,
                       "bytes": target.stat().st_size if exists else None,
                       "reachability": roles or ["unresolved_requires_review"],
                       "literal_sources": literal_sources,
                       "catalog_id": catalog_assets.get(path)})
    return assets


def dependency_reachability(manifest, packages, runtime, evidence):
    direct = {**manifest.get("dependencies", {}), **manifest.get("dev_dependencies", {})}
    implicit = {"cupertino_icons": "Bundled font consumed by Flutter CupertinoIcons controls in reachable router/UI.",
                "flutter_lints": "analysis_options.yaml includes package:flutter_lints/flutter.yaml."}
    return [{"name": name,
             "runtime_importers": sorted(packages.get(name, set()) & runtime),
             "evidence_importers": sorted(packages.get(name, set()) & evidence),
             "implicit_use": implicit.get(name),
             "removal_authorized": False} for name in sorted(direct)]


def collect(root: Path) -> dict:
    root = root.resolve()
    sources = source_locations(root)
    texts = {name: path.read_text(encoding="utf-8") for name, path in sources.items()}
    graph, packages, missing = source_dependencies(root, sources, texts)
    missing_runtime_roots = [name for name in RUNTIME_ROOTS if name not in sources]
    runtime = reachable(graph, (name for name in RUNTIME_ROOTS if name in sources))
    evidence = reachable(graph, (name for name in sources if not name.startswith("lib/")))
    manifest = yaml.safe_load((root / "pubspec.yaml").read_text())
    assets = asset_reachability(root, manifest["flutter"], runtime, texts)
    dependencies = dependency_reachability(manifest, packages, runtime, evidence)

    runtime_files = {name for name in sources if name.startswith("lib/")}
    hashes = {name: sha(path) for name, path in sorted(sources.items())}
    for name in REPORT_INPUTS:
        hashes[name] = sha(root / name)
    return {"schema_version": 1, "status": "fail" if missing or missing_runtime_roots or any(not a["exists"] for a in assets) else "audited",
            "scope": "Conservative declared runtime source/asset/dependency reachability; no deletion authorization or dynamic execution proof.",
            "runtime_roots": RUNTIME_ROOTS, "runtime_source_count": len(runtime_files),
            "missing_runtime_roots": missing_runtime_roots,
            "reachable_runtime_source_count": len(runtime & runtime_files),
            "runtime_unreachable": [{"path": name, "evidence_reachable": name in evidence,
                                     "sha256": hashes[name]} for name in sorted(runtime_files - runtime)],
            "missing_local_directives": missing,
            "assets": assets, "unresolved_bundled_assets": [a["path"] for a in assets if "unresolved_requires_review" in a["reachability"]],
            "dependencies": dependencies, "source_sha256": hashes,
            "limitations": ["Native asset catalogs, external URLs and dynamically constructed assets outside the group allowlist need separate inspection.",
                            "Historical source originals and reports are preserved; they are not unused runtime payload.",
                            "Every evidence Dart file is a root conservatively; helper-file reachability is not a claim that every test executed."]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    document = json.dumps(collect(ROOT), indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    if args.check:
        if not args.output.is_file() or args.output.read_text() != document:
            print("Reachability evidence differs from current inputs.")
            return 1
        print("Reachability evidence matches current inputs.")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        try:
            with args.output.open("x", encoding="utf-8") as target:
                target.write(document)
        except FileExistsError:
            raise FileExistsError("Use a fresh output to preserve earlier evidence.") from None
        print("Wrote conservative reachability evidence.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
