#!/usr/bin/env python3
"""Exercise packaging-tool isolation without installing dependencies or building a DMG."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == 'darwin', 'DMG packaging requires macOS')
class DmgToolsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='latte-dmg-tools-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / 'checkout with spaces'
        scripts = self.root / 'scripts'
        scripts.mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name('package-dmg.sh'), scripts / 'package-dmg.sh')
        (scripts / 'dmg-requirements.txt').write_text('')
        (scripts / 'package-dmg.py').write_text(
            'import json, sys\n'
            'assert sys.prefix != sys.base_prefix, "escaped virtual environment"\n'
            'print(json.dumps({"prefix": sys.prefix}))\n'
        )
        self.target = self.root / 'build with spaces'
        self.venv = self.target / 'dmg-tools'

    def package(self, extra_env=None):
        result = subprocess.run(
            ['bash', str(self.root / 'scripts/package-dmg.sh')],
            env={**os.environ, 'CARGO_TARGET_DIR': str(self.target), **(extra_env or {})},
            text=True, capture_output=True, timeout=90,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual(Path(report['prefix']).resolve(), self.venv.resolve())

    def test_recovers_an_executable_without_its_cached_virtual_environment_metadata(self):
        self.package()
        # A restored build cache can retain the interpreter and dependency marker
        # while losing the metadata that makes Python recognize the venv.
        (self.venv / 'pyvenv.cfg').unlink()
        self.assertTrue((self.venv / 'bin/python').is_file())
        self.assertTrue((self.venv / 'requirements.installed').is_file())
        self.package()
        self.package()  # Reuse the repaired, unchanged private environment.

    def test_ignores_inherited_python_paths_when_creating_and_reusing_tools(self):
        polluted = {'PYTHONHOME': str(self.root / 'missing-python'),
                    'PYTHONPATH': str(self.root / 'foreign-packages')}
        self.package(polluted)
        self.package(polluted)


if __name__ == '__main__':
    unittest.main()
