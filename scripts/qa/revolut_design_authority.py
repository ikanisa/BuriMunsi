#!/usr/bin/env python3
"""Check the design authority for the active BuriMunsi Admin package."""

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PROVIDER = "revolut-design@jean-bosco-skills"
RETIRED_PROVIDER = "revolut-design@created-by-me-remote"
RETIRED_DESIGN_FILES = {
    "design-qa.md",
    "admin_design_qa_2026-09-03.md",
    "legacy_design_eradication_audit_2026-08-05.md",
    "collect-design-contract.json",
}
REFERENCE_SUFFIXES = {".css", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".ts", ".tsx"}


def admin_package_files():
    listed = subprocess.check_output(
        [
            "git",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            "admin-web",
            "deploy/platform-admin",
        ],
        cwd=ROOT,
    )
    return sorted({ROOT / Path(raw.decode()) for raw in listed.split(b"\0") if raw})


def main():
    rules = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    findings = []
    if PROVIDER not in rules or "sole design authority" not in rules:
        findings.append("AGENTS.md must declare the maintained Revolut Design provider.")

    for path in admin_package_files():
        if not path.is_file():
            continue
        name = path.relative_to(ROOT)
        if path.name.lower() in RETIRED_DESIGN_FILES:
            findings.append(f"{name} is a retired design reference.")
        elif path.suffix in REFERENCE_SUFFIXES and RETIRED_PROVIDER in path.read_text(encoding="utf-8"):
            findings.append(f"{name} refers to the retired design provider.")

    if findings:
        raise SystemExit("\n".join(findings))
    print("BuriMunsi Admin uses the maintained Revolut Design authority.")


if __name__ == "__main__":
    main()
