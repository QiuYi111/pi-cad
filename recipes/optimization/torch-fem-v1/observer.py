import json
import os
from pathlib import Path

prefix = os.environ["PI_RECIPE_PATH"]
exports = {"result": {"type": "artifact", "path": f"{prefix}/result.json"}}
for name, kind, candidates in [
    ("density", "field", ["outputs/density.npy", "outputs/density.json"]),
    ("history", "table", ["outputs/history.csv", "outputs/history.json"]),
]:
    found = next((path for path in candidates if Path(path).is_file()), None)
    if found:
        exports[name] = {"type": kind, "path": f"{prefix}/{found}"}
Path(os.environ["PI_RECIPE_OBSERVATION_FILE"]).write_text(json.dumps({"schema": 1, "exports": exports}), encoding="utf-8")
