import json
import os
from pathlib import Path

prefix = os.environ["PI_RECIPE_PATH"]
exports = {"result": {"type": "artifact", "path": f"{prefix}/result.json"}}
for name, kind, candidates in [
    ("hero", "image", ["outputs/hero.png"]),
    ("exploded", "image", ["outputs/exploded.png"]),
    ("manifest", "artifact", ["outputs/render-manifest.json", "outputs/manifest.json"]),
    ("turntable", "artifact", ["outputs/turntable.mp4"]),
    ("assembly", "artifact", ["outputs/assembly.mp4"]),
]:
    found = next((path for path in candidates if Path(path).is_file()), None)
    if found:
        exports[name] = {"type": kind, "path": f"{prefix}/{found}"}
Path(os.environ["PI_RECIPE_OBSERVATION_FILE"]).write_text(json.dumps({"schema": 1, "exports": exports}), encoding="utf-8")
