#!/usr/bin/env python3
"""Recheck BuriMunsi release artifact hashes, embedded notices and exact cached POM declarations."""
import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import re
import zipfile
import xml.etree.ElementTree as ET

from cached_license_evidence import LICENSE_NAME, PART, Witnesses, maven_witness
from gradle_observed_sbom import FLAVOR_CONFIGURATIONS, build as sbom


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_notices(raw, nested=True):
    results = []
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for item in archive.infolist():
            name = item.filename
            if item.is_dir():
                continue
            if LICENSE_NAME.fullmatch(name.rsplit('/', 1)[-1]):
                if item.file_size > 2_000_000:
                    raise ValueError('Notice exceeds read bound')
                text = archive.read(item)
                if text.strip():
                    results.append({'member': name, 'bytes': len(text), 'sha256': sha(text)})
            elif nested and (name == 'classes.jar' or name.startswith('libs/') and name.endswith('.jar')):
                if item.file_size > 100_000_000:
                    raise ValueError('Nested archive exceeds read bound')
                for result in read_notices(archive.read(item), False):
                    results.append({**result, 'member': name + '!/' + result['member']})
    return sorted(results, key=lambda r: (r['member'], r['sha256']))


def pom_declaration(group, module, version, cache, witness):
    lineage, visited = [], set()
    coordinate = (group, module, version)
    while coordinate not in visited and len(visited) < 8:
        visited.add(coordinate)
        group, module, version = coordinate
        proof = maven_witness({'name': group + ':' + module, 'version': version}, [cache], witness)
        poms, parents = [], set()
        for p in proof.get('poms', []):
            path = Path(p['path'])
            poms.append({'cache_path': str(path.relative_to(cache)), **witness.inputs[p['path']],
                         'declared_licenses': p['declared_licenses']})
            doc = ET.fromstring(witness.read(path, cache))
            parent = doc.find('{*}parent')
            if parent is None:
                parents.add(None)
            else:
                parts = tuple((parent.findtext('{*}' + k) or '').strip() for k in ('groupId','artifactId','version'))
                parents.add(parts if all(PART.fullmatch(part) and part not in ('.', '..') for part in parts) else None)
        lineage.append({'coordinate': ':'.join(coordinate), 'poms': poms})
        if proof['status'] == 'pom_license_metadata':
            return ('pom_license_metadata' if len(lineage)==1 else 'inherited_pom_license_metadata'), lineage
        if proof['status'] != 'pom_license_metadata_missing' or len(parents) != 1 or None in parents:
            return proof['status'], lineage
        coordinate = parents.pop()
    return 'parent_chain_unresolved', lineage


def collect(paths, cache):
    cache = cache.resolve(strict=True)
    expected = FLAVOR_CONFIGURATIONS['staff'] | FLAVOR_CONFIGURATIONS['internal_receiver']
    graphs, pins = {}, {}
    for path in paths:
        data = path.read_bytes()
        graph = json.loads(data)
        name = graph['configuration']
        if name not in expected or name in graphs:
            raise ValueError('Unexpected or duplicated release graph')
        graphs[name], pins[name] = graph, sha(data)
    if set(graphs) != expected:
        raise ValueError('Both release roles need both compile and runtime graphs')
    for flavor in ('staff', 'internal_receiver'):
        sbom([graphs[c] for c in sorted(FLAVOR_CONFIGURATIONS[flavor])], pins, flavor)
    coordinates, artifacts = {}, {}
    for name, graph in sorted(graphs.items()):
        for module in (c for c in graph['components'] if c['kind'] == 'module'):
            coordinate = (module['group'], module['name'], module['version'])
            if not all(PART.fullmatch(part) and part not in ('.', '..') for part in coordinate):
                raise ValueError('Invalid Maven coordinate')
            coordinates.setdefault(coordinate, set()).add(name)
        for row in graph['artifacts']:
            module = row['component']
            coordinate = (module['group'], module['name'], module['version'])
            filename = row['file']
            if not re.fullmatch(r'[A-Za-z0-9._+@-]+\.(jar|aar)', filename):
                raise ValueError('Invalid artifact name')
            key = (*coordinate, filename, row['sha256'])
            if key in artifacts:
                artifacts[key]['configurations'].append(name)
                continue
            directory = cache.joinpath(*coordinate)
            candidates = sorted(directory.glob('*/' + filename))
            exact = []
            for file in candidates:
                if file.resolve() != file or not file.is_relative_to(cache) or file.stat().st_size > 100_000_000:
                    raise ValueError('Unbounded or redirected artifact')
                raw = file.read_bytes()
                if len(raw) == row['bytes'] and sha(raw) == row['sha256']:
                    exact.append((file, raw))
            if not exact:
                raise ValueError('No cached bytes match the selected release artifact')
            artifact = {'coordinate': ':'.join(coordinate), 'file': filename, 'bytes': row['bytes'], 'sha256': row['sha256'],
                        'cache_paths': [str(p.relative_to(cache)) for p, _ in exact], 'configurations': [name],
                        'embedded_notices': read_notices(exact[0][1])}
            artifacts[key] = artifact
    witness = Witnesses()
    packages = []
    for (group, module, version), configs in sorted(coordinates.items()):
        status, lineage = pom_declaration(group, module, version, cache, witness)
        packages.append({'coordinate': ':'.join((group, module, version)), 'configurations': sorted(configs),
                         'declaration_status': status, 'pom_lineage': lineage})
    witness.finish()
    return {'format': 'burimunsi.android.observed-release-witnesses.v1', 'graph_sha256': pins,
            'coordinate_count': len(packages), 'package_declarations': packages,
            'declaration_status_counts': dict(Counter(p['declaration_status'] for p in packages)),
            'distinct_artifacts': len(artifacts), 'artifacts_with_embedded_notice': sum(bool(a['embedded_notices']) for a in artifacts.values()),
            'artifact_bindings': [v for _, v in sorted(artifacts.items())], 'distribution_approval': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--graph', type=Path, action='append', required=True)
    parser.add_argument('--maven-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    report = collect(args.graph, args.maven_root)
    raw = json.dumps(report, indent=2, sort_keys=True) + '\n'
    if args.check:
        if args.output.read_text() != raw:
            raise SystemExit('Release evidence changed')
    else:
        with args.output.open('x') as handle:
            handle.write(raw)
    print(json.dumps({k: report[k] for k in ('coordinate_count', 'declaration_status_counts', 'distinct_artifacts', 'artifacts_with_embedded_notice')}))


if __name__ == '__main__':
    main()
