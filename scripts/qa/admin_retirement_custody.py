#!/usr/bin/env python3
"""Compare the local Admin Git tree with the two existing T7 recovery captures."""
import argparse
from collections import Counter
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

from admin_source_candidate import ROOT, REF_PREFIX, git, oid
from collect_release_candidate import exclusion, regular_bytes, safe_relative, sha


def verify(condition, message):
    if not condition:
        raise ValueError(message)


def file_sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def fingerprint(entries):
    return sha(json.dumps(sorted(entries.items()), ensure_ascii=False, separators=(',', ':')).encode())


def retirement_evidence(folder):
    manifest = json.loads((folder / 'manifest.json').read_bytes())
    path = folder / 'source-before-retirement.tar.gz'
    verify(file_sha(path) == manifest['archive_sha256'], 'Flutter archive digest mismatch')
    archived = {}
    comparison = Counter()
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            name = safe_relative(member.name)
            verify(member.isfile() and name not in archived, 'Unexpected Flutter archive member')
            data = archive.extractfile(member).read()
            archived[name] = {'sha256': sha(data), 'bytes': len(data), 'mode': member.mode}
            if not (ROOT / name).exists():
                comparison['absent'] += 1
            else:
                current, _ = regular_bytes(ROOT, name)
                comparison['identical' if current == data else 'edited'] += 1
    verify(archived == manifest['entries'] and len(archived) == manifest['verified_entries'], 'Flutter manifest mismatch')
    deleted = {item.decode() for item in git(ROOT, 'diff', '--diff-filter=D', '--name-only', '-z', 'HEAD').split(b'\0') if item}
    return {'archive_sha256': manifest['archive_sha256'], 'source_commit': manifest['source_commit'], 'verified_files': len(archived),
            'current_paths': dict(comparison), 'working_tree_deletions_in_archive': len(deleted & archived.keys()),
            'working_tree_deletions_outside_archive': sorted(deleted - archived.keys())}


def original_react(folder):
    receipt = json.loads((folder / 'verification/archive-verification.json').read_bytes())
    manifest = gzip.decompress((folder / 'manifest.jsonl.gz').read_bytes())
    verify(sha(manifest) == receipt['descriptor']['manifest_sha256'], 'Original T7 manifest mismatch')
    expected = {}
    for line in manifest.splitlines():
        row = json.loads(line)
        name = row['path']
        if row['kind'] != 'file' or not name.startswith('admin-web/') or exclusion(name):
            continue
        if any(part.startswith('._') or part == '.DS_Store' for part in Path(name).parts):
            continue
        expected[safe_relative(name)] = row['sha256']

    # Stream the preserved archive. Hash its compressed bytes and the selected
    # original React file bodies independently without restoring private data.
    reader = """
      const {createReadStream} = require('node:fs');
      const {createHash} = require('node:crypto');
      const {createZstdDecompress} = require('node:zlib');
      const {pipeline} = require('node:stream/promises');
      const input = createReadStream(process.argv[1]);
      const digest = createHash('sha256');
      input.on('data', data => digest.update(data));
      pipeline(input, createZstdDecompress(), process.stdout).then(() => process.stderr.write(digest.digest('hex')))
        .catch(() => { process.exitCode = 1; });
    """
    result = {}
    with subprocess.Popen(['node', '-e', reader, folder / 'Original-T7-COLLECT.tar.zst'], stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        try:
            with tarfile.open(fileobj=process.stdout, mode='r|', bufsize=1024 * 1024) as archive:
                for member in archive:
                    name = member.name.removeprefix('payload/')
                    if name in expected:
                        verify(member.isfile() and name not in result, 'Unexpected original React member')
                        result[name] = sha(archive.extractfile(member).read())
            while process.stdout.read(1024 * 1024):
                pass
            verify(process.wait() == 0 and process.stderr.read().decode() == receipt['archive_sha256'], 'Original T7 archive mismatch')
        finally:
            if process.poll() is None:
                process.kill()
    verify(expected == result, 'Original React source bytes differ from the verified manifest')
    return result, {'archive_sha256': receipt['archive_sha256'], 'manifest_sha256': sha(manifest),
                    'source_files': len(result), 'source_sha256': fingerprint(result)}


def current_react(ref):
    verify(ref.startswith(REF_PREFIX) and oid(ROOT, 'rev-parse', '--verify', ref) == ref.split('/')[-1], 'Invalid product tree ref')
    files = []
    for entry in git(ROOT, 'ls-tree', '-r', '-z', ref, '--', 'admin-web').split(b'\0'):
        if entry:
            info, name = entry.split(b'\t', 1)
            mode, kind, blob = info.split()
            verify(kind == b'blob' and mode in (b'100644', b'100755'), 'Unexpected product tree member')
            files.append((blob, safe_relative(name.decode())))
    raw = io.BytesIO(git(ROOT, 'cat-file', '--batch', data=b''.join(blob + b'\n' for blob, _ in files)))
    result = {}
    for blob, name in files:
        obj, kind, length = raw.readline().split()
        verify((obj, kind) == (blob, b'blob'), 'Unexpected product tree object')
        result[name] = sha(raw.read(int(length)))
        verify(raw.read(1) == b'\n', 'Incomplete product tree object')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--retirement', required=True, type=Path)
    parser.add_argument('--original', required=True, type=Path)
    parser.add_argument('--ref', required=True)
    args = parser.parse_args()
    old, original = original_react(args.original)
    current = current_react(args.ref)
    shared = current.keys() & old.keys()
    print(json.dumps({'original_t7_react': original, 'admitted_react': {'ref': args.ref, 'files': len(current), 'source_sha256': fingerprint(current)},
                      'react_paths': {'original_only': len(old.keys() - current.keys()), 'admitted_only': len(current.keys() - old.keys()),
                                      'identical': sum(old[k] == current[k] for k in shared), 'edited': sum(old[k] != current[k] for k in shared)},
                      'flutter_retirement': retirement_evidence(args.retirement)}, indent=2))
