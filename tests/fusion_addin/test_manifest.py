import json
import os
import re
import unittest

import _path


def _read(p):
    with open(p) as fh:
        return fh.read()


class ManifestTests(unittest.TestCase):
    def test_version_matches(self):
        with open(os.path.join(_path.ADDIN, "ReifyExport.manifest")) as fh:
            m = json.load(fh)
        src = _read(os.path.join(_path.ADDIN, "ReifyExport.py"))
        ver = re.search(r'^__version__ = "([^"]+)"', src, re.M).group(1)
        self.assertEqual(m["version"], ver)
        import ReifyExport  # must import without adsk
        self.assertEqual(ReifyExport.__version__, ver)
        self.assertEqual(m["type"], "addin")
        self.assertIs(m["runOnStartup"], False)
        self.assertEqual(m["supportedOS"], "windows|mac")
        self.assertTrue(m["id"])
        self.assertTrue(m["description"])

    def test_pure_modules_do_not_import_adsk(self):
        for name in ("jobroot", "jobs", "plan", "profiles", "geom", "workers"):
            src = _read(os.path.join(_path.ADDIN, name + ".py"))
            self.assertNotRegex(src, r"^\s*(import|from)\s+adsk", name)


if __name__ == "__main__":
    unittest.main()
