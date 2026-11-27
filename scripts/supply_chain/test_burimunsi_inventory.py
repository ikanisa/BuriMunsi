import json
from pathlib import Path
import re
import tempfile
import unittest

import inventory
import source_sbom


class BuriMunsiInventoryTest(unittest.TestCase):
    def test_native_product_and_current_locks_reach_the_source_sbom(self):
        document = inventory.build()
        expected_locks = {
            "admin-web/package-lock.json",
            "deploy/platform-admin/package-lock.json",
            "deploy/managed-sms/package-lock.json",
            "deploy/managed-sms/deno.lock",
            "scripts/supabase/package-lock.json",
            "scripts/supabase/deno.lock",
            "supabase/functions/deno.lock",
        }
        bound_locks = {path for path in document["source_sha256"]
                       if path.endswith(("/package-lock.json", "/deno.lock"))}
        self.assertEqual(expected_locks, bound_locks)
        rows = document["packages"]
        self.assertTrue(any(row["name"] == "com.android.tools:r8" and row["version"] for row in rows))
        self.assertTrue(any(row["name"] == "androidx.compose:compose-bom" and row["version"] for row in rows))
        self.assertTrue(any(row["name"] == "androidx.compose.ui:ui" and row["version"] is None for row in rows))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "inventory.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            bom = source_sbom.build(path)
        gradle = (inventory.ROOT / "native/burimunsi/app/build.gradle.kts").read_text()
        version = re.search(r'^\s*versionName\s*=\s*"([^"]+)"', gradle, re.M).group(1)
        self.assertEqual(bom["metadata"]["component"], {
            "type": "application", "bom-ref": "application:burimunsi-source",
            "name": "BuriMunsi", "version": version,
        })


if __name__ == "__main__":
    unittest.main()
