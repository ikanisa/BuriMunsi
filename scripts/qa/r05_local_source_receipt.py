"""Run a small local source qualification; never represents hosted or full CI."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

from l04_alert_checkpoint import _storage

CHECKS = (
    ("source", ("make", "check-source")),
    ("design", ("make", "revolut-design-authority")),
    ("offline-alerts", (sys.executable, "-m", "unittest", "discover",
                        "-s", "scripts/qa", "-p", "test_l04_alert_*.py")),
)
NOT_RUN = ('hosted-ci', 'edge', 'gateway', 'jobs', 'postgres', 'admin', 'android')


def _run(command, root, capture=False):
    return subprocess.run(command, cwd=root, stdin=subprocess.DEVNULL, timeout=120,
                          stderr=subprocess.DEVNULL,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL)


def source(root):
    commit = _run(("git", "rev-parse", "--verify", "HEAD"), root, True)
    status = _run(("git", "status", "--porcelain=v1", "--untracked-files=normal"), root, True)
    commit.check_returncode()
    status.check_returncode()
    if status.stdout:
        raise ValueError("checkout is not clean")
    return commit.stdout.decode("ascii").strip()


def qualify(root, run=_run, identify=source):
    commit = identify(root)
    started = datetime.now(timezone.utc)
    results = {}
    for name, argv in CHECKS:
        try:
            results[name] = 'PASS' if run(argv, root).returncode == 0 else 'FAIL'
        except (OSError, subprocess.TimeoutExpired):
            results[name] = 'BLOCKED'
    if identify(root) != commit:
        raise ValueError("checkout changed during checks")
    return {'version': 1, 'source_commit': commit,
            'started_utc': started.isoformat(),
            'finished_utc': datetime.now(timezone.utc).isoformat(),
            'platform': platform.system(), 'architecture': platform.machine(),
            'result': {**results, **dict.fromkeys(NOT_RUN, 'NOT RUN')}}


def save(path, receipt):
    p = _storage(path)
    # Stage the complete receipt privately, then hard-link without overwriting.
    import tempfile
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=p.parent, delete=False) as fh:
            tmp = Path(fh.name)
            json.dump(receipt, fh, indent=2, sort_keys=True)
            fh.write('\n')
            fh.flush()
            os.fsync(fh.fileno())
        os.link(tmp, p, follow_symlinks=False)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    try:
        record = qualify(root)
        save(args.receipt, record)
    except (OSError, ValueError, subprocess.SubprocessError):
        print("No receipt written. Verify clean checkout, prerequisites and private destination.", file=sys.stderr)
        return 2
    print(json.dumps(record, sort_keys=True))
    return int(any(record['result'][label] != 'PASS' for label, _ in CHECKS))


if __name__ == "__main__":
    raise SystemExit(main())
