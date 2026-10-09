import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ADDIN = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "executors", "fusion", "ReifyExport"))
FIXTURES = os.path.abspath(os.path.join(HERE, "..", "..", "..", "fixtures", "transfer"))
for p in (ADDIN, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)


def sample():
    import json
    with open(os.path.join(FIXTURES, "sample_plate.features.json")) as fh:
        return json.load(fh)


def fixture(name):
    import json
    with open(os.path.join(FIXTURES, name)) as fh:
        return json.load(fh)
