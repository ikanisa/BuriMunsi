#!/usr/bin/env python3
"""Pinned, quiet, offline-content release scans. No report or findings are written."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
VERSION = '8.30.1'
POLICY = b'title = "BuriMunsi Gitleaks policy"\n[extend]\nuseDefault = true\n'
# https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
PINS = {
    ('Darwin', 'arm64'): ('darwin_arm64', 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'),
    ('Darwin', 'x86_64'): ('darwin_x64', 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709'),
    ('Linux', 'aarch64'): ('linux_arm64', 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'),
    ('Linux', 'x86_64'): ('linux_x64', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'),
}
CHUNK = 1024 * 1024
MAX_FILE = 128 * CHUNK
MAX_TOTAL = 1024 * CHUNK
MAX_FILES = 24000
ZIP_SUFFIXES = {'.zip', '.apk', '.aab', '.jar'}
UNSUPPORTED_ARCHIVE_SUFFIXES = {'.7z', '.tar', '.gz', '.bz2', '.xz', '.rar', '.zst', '.br', '.tgz', '.ipa'}
BINARY_BYTES = bytes.maketrans(bytes(range(256)), bytes(i if i in (9, 10, 13) or 32 <= i <= 126 else 10 for i in range(256)))


class Refused(Exception):
    pass


def runtime_env(home):
    return {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_NO_LAZY_FETCH': '1'}


def command(args, directory, env, timeout, capture=False):
    return subprocess.run(args, cwd=directory, env=env, timeout=timeout, check=False, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL)


def verified_scanner(work, env):
    target = PINS.get((platform.system(), platform.machine()))
    if not target:
        raise Refused('unsupported scanner platform')
    platform_asset, expected = target
    name = f'gitleaks_{VERSION}_{platform_asset}.tar.gz'
    archive = work / 'scanner.tar.gz'
    url = f'https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/{name}'
    result = command(['curl', '-q', '--fail', '--silent', '--location', '--proto', '=https',
                      '--proto-redir', '=https', '--max-time', '45', '--max-filesize', str(32 * CHUNK),
                      '--output', str(archive), url], work, env, 50)
    if result.returncode:
        raise Refused('pinned scanner download unavailable')
    with archive.open('rb') as f:
        digest = hashlib.sha256()
        for block in iter(lambda: f.read(CHUNK), b''):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise Refused('pinned scanner checksum mismatch')
    scanner = work / 'gitleaks'
    with tarfile.open(archive, 'r:gz') as package:
        member = package.getmember('gitleaks')
        if not member.isfile() or not 0 < member.size <= 64 * CHUNK:
            raise Refused('unexpected scanner archive')
        with package.extractfile(member) as source, scanner.open('xb') as dest:
            shutil.copyfileobj(source, dest)
    scanner.chmod(0o700)
    result = command([str(scanner), 'version'], work, env, 10, True)
    if result.returncode or result.stdout.strip() != VERSION.encode():
        raise Refused('pinned scanner version mismatch')
    return scanner


def git_output(root, env, *args):
    result = command(['git', '--no-replace-objects', *args], root, env, 35, True)
    if result.returncode:
        raise Refused('Git inventory unavailable')
    return result.stdout


def history_preflight(root, env):
    if git_output(root, env, 'rev-parse', '--is-shallow-repository') != b'false\n':
        raise Refused('shallow Git history')
    if git_output(root, env, 'config', '--local', '--list', '-z').find(b'promisor\ntrue\x00') >= 0:
        raise Refused('partial Git history')
    if git_output(root, env, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'):
        raise Refused('uncommitted source in Git checkout')
    git_output(root, env, 'rev-parse', '--verify', 'HEAD^{commit}')
    # Fail on missing reachable objects rather than permitting a partial scan.
    if b'?' in {entry[:1] for entry in git_output(
            root, env, 'rev-list', '--objects', '--all', 'HEAD', '--missing=print', '--no-object-names').splitlines()}:
        raise Refused('missing Git objects')


def history_group_digests(findings):
    """Bind the detector's exact matched bytes to an immutable commit and source position."""
    groups = {}
    for hit in findings:
        commit = hit['Commit']
        if (not re.fullmatch(r'[0-9a-f]{40}', commit) or not hit['File'] or not hit['RuleID']
                or not 0 < hit['StartLine'] <= hit['EndLine'] or not hit['Secret'] or not hit['Match']):
            raise Refused('incomplete history finding')
        identity = [commit, hit['File'], hit['RuleID'], hit['StartLine'], hit['EndLine'],
                    hashlib.sha256(hit['Secret'].encode()).hexdigest(),
                    hashlib.sha256(hit['Match'].encode()).hexdigest()]
        groups.setdefault(commit, set()).add(json.dumps(identity, separators=(',', ':')))
    return {commit: hashlib.sha256('\n'.join(sorted(rows)).encode()).hexdigest()
            for commit, rows in groups.items()}


def verify_history_report(report, code, root, env):
    review = json.loads((ROOT / 'scripts/release/reviewed-history.json').read_bytes())
    reachable = set(git_output(root, env, 'rev-list', '--all', 'HEAD').decode('ascii').splitlines())
    if (review['scannerVersion'] != VERSION or review['reviewedSource'] not in reachable
            or review['policySha256'] != hashlib.sha256(POLICY).hexdigest()
            or git_output(root, env, 'rev-parse', review['reviewedSource'] + '^{tree}').decode().strip()
            != review['reviewedTree']):
        raise Refused('history review does not cover this repository or scanner')
    if len(report) > 32 * CHUNK:
        raise Refused('history findings exceed private review limit')
    findings = json.loads(report)
    if type(findings) is not list or bool(findings) != (code == 19):
        raise Refused('incomplete history scan report')
    expected = {commit: digest for commit, digest in review['commitDigests'].items() if commit in reachable}
    if history_group_digests(findings) != expected:
        raise Refused('git findings require private review')


def run_scan(scanner, work, env, mode, path):
    # Only the private parent process receives the Git JSON report through a pipe.
    # Scanner diagnostics and matched text must never reach the terminal or a file.
    config, ignore = work / 'strict.toml', work / 'empty.ignore'
    if (ROOT / '.gitleaks.toml').read_bytes() != POLICY:
        raise Refused('unreviewed scanner policy')
    config.write_bytes(POLICY)
    ignore.write_text('')
    args = [str(scanner), mode, '--config', str(config), '--gitleaks-ignore-path', str(ignore),
            '--ignore-gitleaks-allow', '--no-banner', '--exit-code=19', '--max-decode-depth=2']
    if mode == 'git':
        args += ['--log-opts=--all HEAD --full-history -m --no-ext-diff --no-textconv',
                 '--report-path=-', '--report-format=json', '--redact=0', '--log-level=error']
    else:
        args += ['--redact=100']
    result = command(args + [str(path)], work, env, 540, capture=(mode == 'git'))
    if result.returncode not in (0, 19):
        raise Refused(f'{mode} scanner failed')
    if mode == 'git':
        verify_history_report(result.stdout, result.returncode, path, env)
    elif result.returncode == 19:
        raise Refused(f'{mode} findings require private review')


def verify_detection_is_live(scanner, work, env):
    # Deliberately fake, composed only at run time and always outside Git.
    # Missing built-in rules must block even if a scanner exits zero.
    probe = work / 'positive-control'
    probe.mkdir(mode=0o700)
    prefix = 'gh' + 'p_'
    fixture = '0Ayb9XfCzH1jk7ST' + 'm2VQr5wdEuKp3Ns8GLM4'
    (probe / 'probe.txt').write_text(f'credential = {prefix}{fixture} # gitleaks:allow\n')
    try:
        run_scan(scanner, work, env, 'dir', probe)
    except Refused as error:
        if str(error) == 'dir findings require private review':
            return
        raise
    raise Refused('pinned scanner positive control missed the synthetic indicator')


class ArtifactInventory:
    """Bounded copies owned by this run. ZIP-family members are copied, never extracted by path."""
    def __init__(self, directory):
        self.directory = directory
        self.count = self.total = self.visits = 0

    def add(self, source, size):
        self.count += 1
        self.total += size
        if self.count > MAX_FILES or not 0 <= size <= MAX_FILE or self.total > MAX_TOTAL:
            raise Refused('artifact size/count limit')
        name = self.directory / f'{self.count}.txt'
        read = 0
        with name.open('xb') as target:
            binary = None
            for block in iter(lambda: source.read(CHUNK), b''):
                if binary is None:
                    binary = b'\x00' in block
                    if block.startswith((b'PK\x03\x04', b'PK\x05\x06', b'\x1f\x8b', b'7z\xbc\xaf\x27\x1c',
                                         b'\xfd7zXZ\x00', b'Rar!\x1a\x07', b'BZh', b'\x28\xb5\x2f\xfd')) or (
                            len(block) > 262 and block[257:262] == b'ustar'):
                        raise Refused('nested or unsupported compressed artifact')
                read += len(block)
                if read > size:
                    raise Refused('artifact size changed')
                target.write(block.translate(BINARY_BYTES) if binary else block)
        if read != size:
            raise Refused('artifact size changed')

    def archive(self, file):
        before = self.count
        seen = set()
        with zipfile.ZipFile(file) as archive:
            if not archive.infolist():
                raise Refused('empty artifact archive')
            for entry in archive.infolist():
                raw = entry.orig_filename
                parts = PurePosixPath(raw)
                if (not raw or chr(0) in raw or '\\' in raw or parts.is_absolute() or '..' in parts.parts
                        or ':' in raw or parts in seen or len(seen) >= MAX_FILES
                        or entry.flag_bits & 1 or not (entry.compress_type in {zipfile.ZIP_DEFLATED, zipfile.ZIP_STORED})):
                    raise Refused('unsafe or encrypted artifact archive')
                seen.add(parts)
                kind = stat.S_IFMT(entry.external_attr >> 16)
                if entry.is_dir():
                    if kind not in (0, stat.S_IFDIR) or entry.file_size:
                        raise Refused('unsupported archive member')
                    continue
                if (kind not in (0, stat.S_IFREG)
                        or parts.suffix.lower() in (ZIP_SUFFIXES | UNSUPPORTED_ARCHIVE_SUFFIXES)):
                    raise Refused('unsupported archive member')
                with archive.open(entry) as content:
                    self.add(content, entry.file_size)
        if self.count == before:
            raise Refused('empty artifact archive')

    def file(self, path, info):
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            raise Refused('artifact must be an owned regular file or directory')
        suffix = path.suffix.lower()
        if suffix in UNSUPPORTED_ARCHIVE_SUFFIXES:
            raise Refused('unsupported compressed artifact')
        if info.st_size > MAX_FILE:
            raise Refused('artifact size/count limit')
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as file:
            original = os.fstat(file.fileno())
            def identity(f):
                return f.st_dev, f.st_ino, f.st_size, f.st_mtime_ns, f.st_ctime_ns, f.st_nlink, f.st_mode, f.st_uid
            if identity(original) != identity(info):
                raise Refused('artifact changed during scan')
            if suffix in ZIP_SUFFIXES:
                self.archive(file)
            else:
                self.add(file, info.st_size)
            if identity(os.fstat(file.fileno())) != identity(original):
                raise Refused('artifact changed during scan')

    def visit(self, path):
        self.visits += 1
        if self.visits > MAX_FILES:
            raise Refused('artifact size/count limit')
        if path.name == '.git':
            raise Refused('artifact must not include repositories')
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid():
            for child in path.iterdir():
                self.visit(child)
        else:
            self.file(path, info)


def main(args):
    repo = args == [] or args == ['--history']
    if not repo and not (len(args) >= 2 and args[0] == '--artifacts'):
        raise Refused('use --history or --artifacts followed by explicit paths')
    with tempfile.TemporaryDirectory(prefix='burimunsi-secret-scan-') as tmp:
        work = Path(tmp)
        env = runtime_env(work)
        if repo:
            history_preflight(ROOT, env)
            scanner = verified_scanner(work, env)
            verify_detection_is_live(scanner, work, env)
            run_scan(scanner, work, env, 'git', ROOT)
            print('[secret-scan] PASS Git HEAD and reachable local refs; reviewed history matches')
        else:
            directory = work / 'inputs'
            directory.mkdir(mode=0o700)
            inventory = ArtifactInventory(directory)
            for argument in args[1:]:
                path = Path(os.path.abspath(argument))
                physical = path.parent.resolve(strict=True) / path.name
                if (physical == ROOT or physical == Path.home() or physical in ROOT.parents
                        or physical in work.parents or physical in Path.home().parents):
                    raise Refused('artifact must be an explicit release output, not a whole workspace')
                if inventory.count > MAX_FILES:
                    raise Refused('artifact size/count limit')
                inventory.visit(physical)
            if inventory.count == 0:
                raise Refused('artifact input empty')
            scanner = verified_scanner(work, env)
            verify_detection_is_live(scanner, work, env)
            run_scan(scanner, work, env, 'dir', directory)
            print('[secret-scan] PASS explicitly supplied artifacts')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Refused as exc:
        print('[secret-scan] BLOCKED: ' + str(exc), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, TypeError, KeyError, RuntimeError, NotImplementedError,
            subprocess.TimeoutExpired, tarfile.TarError, zipfile.BadZipFile, EOFError):
        print('[secret-scan] BLOCKED: tool, repository or artifact unavailable', file=sys.stderr)
        sys.exit(1)
