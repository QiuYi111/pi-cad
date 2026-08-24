import json
import os
from pathlib import Path

prefix = os.environ["PI_RECIPE_PATH"]
exports = {"result": {"type": "artifact", "path": f"{prefix}/result.json"}}
for name, candidates in [
    ("analysis_model", ["outputs/analysis-model.step", "outputs/analysis_model.step"]),
    ("derivation_record", ["outputs/derivation.json", "outputs/derivation-record.json"]),
]:
    found = next((path for path in candidates if Path(path).is_file()), None)
    if found:
        exports[name] = {"type": "artifact", "path": f"{prefix}/{found}"}
Path(os.environ["PI_RECIPE_OBSERVATION_FILE"]).write_text(json.dumps({"schema": 1, "exports": exports}), encoding="utf-8")
