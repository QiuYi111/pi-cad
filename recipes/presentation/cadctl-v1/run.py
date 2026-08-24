import json
import os
import subprocess
from pathlib import Path

action = os.environ["PI_RECIPE_ACTION"]
if action not in {"validate", "preview", "generate", "run"}:
    raise SystemExit(f"unsupported presentation action: {action}")
Path("outputs").mkdir(exist_ok=True)
completed = subprocess.run(
    [os.environ["PI_CAD_PYTHON"], "-m", "cadctl", "present", action, "--spec", "spec.json", "--output-dir", "outputs"],
    check=False, capture_output=True, text=True,
)
Path("result.json").write_text(completed.stdout or json.dumps({"ok": False, "payload": {"error": completed.stderr}}), encoding="utf-8")
raise SystemExit(completed.returncode)
