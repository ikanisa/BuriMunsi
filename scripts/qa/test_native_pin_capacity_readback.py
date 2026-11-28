import io
import json
from pathlib import Path
import subprocess
import sys
import unittest

import native_pin_capacity_readback as readback

SOURCE = "a" * 64
BASE = dict(service="collect_platform_api", schema_version=1, event="service_degraded",
            component="platform", status=503, request_id=None, elapsed_ms=100, source_id=SOURCE)
TAGGED = {**BASE, **readback.TUPLE}
SUPPRESSED = {**BASE, "event": "events_suppressed", "status": None, "elapsed_ms": None}


def encode(*events):
    return b"".join((json.dumps(e) + "\n").encode() for e in events)


class CapacityReadbackTests(unittest.TestCase):
    def test_scopes_counts_to_source_and_exact_tuple(self):
        data = encode(TAGGED, TAGGED, BASE, SUPPRESSED, {**TAGGED, "cause": "other"},
                      {**TAGGED, "source_id": "b" * 64}, {**TAGGED, "status": "503"},
                      {**TAGGED, "schema_version": True}, {**TAGGED, "request_id": "not echoed"},
                      {**TAGGED, "component": "auth"}, {**TAGGED, "event": "runtime_unavailable"})
        result = readback.summarize(io.BytesIO(data), SOURCE)
        self.assertEqual(result["input_rows"], 11)
        self.assertEqual(result["tagged_pin_registration_capacity_rows"], 2)
        self.assertEqual(result["other_platform_degraded_503_rows"], 3)
        self.assertEqual(result["source_platform_degraded_503_rows"], 5)
        self.assertEqual(result["source_suppression_notices"], 1)
        self.assertEqual(result["ignored_rows"], 5)
        self.assertIs(result["coverage_proven"], False)

    def test_rejects_ambiguous_and_invalid_exports(self):
        for data in (b"", b"null\n", b'{"event":"x","event":"y"}\n', b'{"a":NaN}\n',
                     b'\xff', b'a' * (readback.MAX_LINE_BYTES + 1)):
            with self.subTest(size=len(data), head=data[:1]), self.assertRaises(ValueError):
                readback.summarize(io.BytesIO(data), SOURCE)
        with self.assertRaises(ValueError):
            readback.summarize(io.BytesIO(encode(BASE)), SOURCE[:40])

    def test_row_limit_fails_instead_of_returning_partial_counts(self):
        original = readback.MAX_RECORDS
        try:
            readback.MAX_RECORDS = 2
            with self.assertRaisesRegex(ValueError, "limit"):
                readback.summarize(io.BytesIO(encode(BASE, BASE, BASE)), SOURCE)
        finally:
            readback.MAX_RECORDS = original

    def test_cli_never_emits_payload_or_partial_result(self):
        script = Path(readback.__file__)
        verb = [sys.executable, str(script), "--source", SOURCE]
        fixture = encode({**TAGGED, "private": "must-not-repeat-raw-data"})
        okay = subprocess.run(verb, input=fixture, capture_output=True)
        self.assertEqual(okay.returncode, 0)
        self.assertEqual(okay.stderr, b"")
        self.assertNotIn(b"must-not-repeat-raw-data", okay.stdout)
        self.assertEqual(json.loads(okay.stdout)["tagged_pin_registration_capacity_rows"], 1)
        failed = subprocess.run(verb, input=fixture + b"must-not-repeat-bad-data", capture_output=True)
        self.assertEqual(failed.returncode, 2)
        self.assertEqual(failed.stdout, b"")
        self.assertNotIn(b"must-not-repeat-bad-data", failed.stderr)


if __name__ == "__main__":
    unittest.main()
