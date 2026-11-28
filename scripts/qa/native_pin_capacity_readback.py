#!/usr/bin/env python3
"""Count scoped BuriMunsi PIN admission diagnostics without exporting raw logs."""
import argparse
import json
import re
import sys

MAX_RECORDS = 50_000
MAX_LINE_BYTES = 16_384
SOURCE = re.compile(r"[a-f0-9]{64}")
TUPLE = {
    "operation": "native_pin_login",
    "stage": "registration_rejected",
    "cause": "collect_fence_capacity",
}
COVERAGE_LIMIT = (
    "Counts are log rows, not unique requests. This is not a login failure rate, "
    "a root-cause finding, a recovery result, or authority to retry."
)


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate JSON key")
        obj[key] = value
    return obj


def reject_constant(_):
    raise ValueError("non-JSON constant")


def summarize(stream, source):
    if not SOURCE.fullmatch(source):
        raise ValueError("source must be the independently verified deployed SHA-256")
    counts = dict(input_rows=0, ignored_rows=0, source_platform_degraded_503_rows=0,
                  tagged_pin_registration_capacity_rows=0,
                  other_platform_degraded_503_rows=0, source_suppression_notices=0)
    while line := stream.readline(MAX_LINE_BYTES + 1):
        counts["input_rows"] += 1
        if counts["input_rows"] > MAX_RECORDS or len(line) > MAX_LINE_BYTES:
            raise ValueError("capture limit exceeded")
        try:
            event = json.loads(line.decode("utf-8"), object_pairs_hook=unique_object,
                               parse_constant=reject_constant)
            if not isinstance(event, dict):
                raise ValueError("not a JSON object")
        except (ValueError, RecursionError):
            raise ValueError("invalid JSON record; export decoded NDJSON objects") from None
        if not (event.get("service") == "collect_platform_api"
                and type(event.get("schema_version")) is int and event["schema_version"] == 1
                and event.get("source_id") == source and event.get("component") == "platform"):
            counts["ignored_rows"] += 1
            continue
        kind = event.get("event")
        if (kind == "events_suppressed"
                and all(field in event and event[field] is None
                        for field in ("status", "request_id", "elapsed_ms"))):
            counts["source_suppression_notices"] += 1
        elif (kind == "service_degraded" and type(event.get("status")) is int and event["status"] == 503
                and type(event.get("elapsed_ms")) is int and 0 <= event["elapsed_ms"] <= 3_600_000):
            counts["source_platform_degraded_503_rows"] += 1
            if ("request_id" in event and event["request_id"] is None
                    and all(event.get(k) == v for k, v in TUPLE.items())):
                counts["tagged_pin_registration_capacity_rows"] += 1
            else:
                counts["other_platform_degraded_503_rows"] += 1
        else:
            counts["ignored_rows"] += 1
    if counts["input_rows"] == 0:
        raise ValueError("empty capture; distinguish missing evidence from zero events")
    return {"source_id": source, **counts, "coverage_proven": False, "interpretation": COVERAGE_LIMIT}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True,
                        help="verified deployed BUILD_SOURCE_ID (SHA-256), not Git commit")
    args = parser.parse_args()
    try:
        report = summarize(sys.stdin.buffer, args.source)
    except (ValueError, OSError) as error:
        # Do not display file/path errors or payload fragments from parsing.
        message = str(error) if isinstance(error, ValueError) else "could not read capture"
        sys.stderr.write(f"Readback rejected: {message}\n")
        return 2
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
