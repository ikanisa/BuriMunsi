"""Verify restored operator links from an already mounted, read-only COPY snapshot."""
import argparse
import csv
import hashlib
import json
from io import TextIOWrapper
import os
from pathlib import Path
import re
import sys

from role_linkage import inspect_role_links


def inspect_dump(root, expected_inventory_sha256):
    if not re.fullmatch(r"[0-9a-f]{64}", expected_inventory_sha256):
        raise ValueError("Expected a SHA-256 inventory digest")
    root = Path(root).absolute()
    inventory = root / "postgres-copy-inventory.json"
    if root != root.resolve(strict=True) or inventory.is_symlink() or inventory.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Invalid source inventory")
    raw = inventory.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_inventory_sha256:
        raise ValueError("Source inventory digest mismatch")
    relations = json.loads(raw)["relations"]
    entries = {r["schema"] + "." + r["name"]: r for r in relations}
    if len(entries) != len(relations):
        raise ValueError("Duplicate relation")

    def rows(relation):
        entry = entries[relation]
        if not re.fullmatch(r"[0-9]{4}\.csv", entry["file"]):
            raise ValueError("Invalid relation filename")
        data = root / "tables" / entry["file"]
        if data != data.resolve(strict=True) or not data.is_file():
            raise ValueError("Invalid data path")
        fields = [c["name"] for c in entry["columns"]]
        if not fields or len(set(fields)) != len(fields):
            raise ValueError("Invalid source fields")
        with data.open("rb") as raw_data:
            if os.fstat(raw_data.fileno()).st_size != entry["bytes"]:
                raise ValueError("Source relation size mismatch")
            if hashlib.file_digest(raw_data, "sha256").hexdigest() != entry["sha256"]:
                raise ValueError("Source relation digest mismatch")
            raw_data.seek(0)
            with TextIOWrapper(raw_data, encoding="utf-8", newline="") as stream:
                for values in csv.reader(stream, strict=True):
                    if len(values) != len(fields):
                        raise ValueError("Malformed source relation")
                    yield dict(zip(fields, values))
    return inspect_role_links(rows)


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("mount", type=Path)
    args.add_argument("--inventory-sha256", required=True)
    values = args.parse_args()
    try:
        csv.field_size_limit(16 * 1024 * 1024)
        result = inspect_dump(values.mount, values.inventory_sha256)
    except (OSError, ValueError, KeyError, TypeError, csv.Error):
        print("Restored role linkage could not be verified.", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 1 if result["brokenRelationships"] else 0


if __name__ == "__main__":
    sys.exit(main())
