import json
import os
import subprocess
from pathlib import Path

Path("outputs").mkdir(exist_ok=True)
completed = subprocess.run(
    [os.environ["PI_CAD_PYTHON"], "-m", "cadctl", "derive-analysis-model", "--spec", "spec.json", "--output-dir", "outputs"],
    check=False, capture_output=True, text=True,
)
Path("result.json").write_text(completed.stdout or json.dumps({"ok": False, "payload": {"error": completed.stderr}}), encoding="utf-8")
raise SystemExit(completed.returncode)
