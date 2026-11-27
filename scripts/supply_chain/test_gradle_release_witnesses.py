import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from gradle_observed_sbom import FLAVOR_CONFIGURATIONS, build
from gradle_release_witnesses import collect


class ReleaseGraphWitnessTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.cache = self.base / 'cache'
        child = self.cache / 'example.group/mod/1.0/pinned'
        parent = self.cache / 'example.group/parent/1.0/pinned'
        child.mkdir(parents=True)
        parent.mkdir(parents=True)
        (child / 'mod.pom').write_text('<project><groupId>example.group</groupId><artifactId>mod</artifactId><version>1.0</version>'
            '<parent><groupId>example.group</groupId><artifactId>parent</artifactId><version>1.0</version></parent></project>')
        (parent / 'parent.pom').write_text('<project><groupId>example.group</groupId><artifactId>parent</artifactId><version>1.0</version>'
            '<licenses><license><name>Example licence</name></license></licenses></project>')
        self.artifact = child / 'mod-1.0.jar'
        with zipfile.ZipFile(self.artifact, 'w') as archive:
            archive.writestr('META-INF/LICENSE', 'example notice')
        raw = self.artifact.read_bytes()
        module = {'kind':'module','group':'example.group','name':'mod','version':'1.0'}
        row = {'component':module,'file':self.artifact.name,'kind':'jar','exists':True,
               'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        self.graphs = []
        for role in ('staff','internal_receiver'):
            for conf in sorted(FLAVOR_CONFIGURATIONS[role]):
                path = self.base / (conf+'.json')
                path.write_text(json.dumps({'configuration':conf,'components':[module],'edges':[], 'artifacts':[row]}))
                self.graphs.append(path)

    def test_all_four_hashes_and_parent_pom_are_bound(self):
        result = collect(self.graphs,self.cache)
        self.assertEqual(result['declaration_status_counts'],{'inherited_pom_license_metadata':1})
        self.assertEqual(len(result['graph_sha256']),4)
        self.assertEqual(result['distinct_artifacts'],1)
        self.assertEqual(result['artifacts_with_embedded_notice'],1)
        for paths in [self.graphs[:2], self.graphs[:3]+[self.graphs[0]]]:
            with self.assertRaises(ValueError):
                collect(paths,self.cache)
        with self.assertRaises(ValueError):
            build([json.loads(self.graphs[i].read_bytes()) for i in (0,3)],{},'staff')
        self.artifact.write_bytes(b'different')
        with self.assertRaises(ValueError):
            collect(self.graphs,self.cache)


if __name__=='__main__':
    unittest.main()
