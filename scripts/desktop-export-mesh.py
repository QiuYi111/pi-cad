#!/usr/bin/env python3
from __future__ import annotations

import json
import sys

from cadctl.mesh import mesh_document


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: desktop-export-mesh.py model.step")
    json.dump(mesh_document(sys.argv[1]), sys.stdout, separators=(",", ":"))
