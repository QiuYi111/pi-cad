from __future__ import annotations

import json
from pathlib import Path

from cadctl.simulation.thermal_api import run_thermal


root = Path(__file__).resolve().parent
payload = run_thermal(root / "case.json", root / "results")
(root / "result.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
if payload.get("status") != "solved":
    raise SystemExit(f"SU2 thermal solve did not converge: {payload.get('reason', payload.get('status'))}")
