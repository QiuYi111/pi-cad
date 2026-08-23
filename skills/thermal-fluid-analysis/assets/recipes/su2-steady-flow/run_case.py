from __future__ import annotations

import json
from pathlib import Path

from cadctl.simulation.flow_api import run_flow


root = Path(__file__).resolve().parent
payload = run_flow(root / "case.json", root / "results")
(root / "result.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
if payload.get("status") != "solved":
    raise SystemExit(f"SU2 flow did not produce a converged solution: {payload.get('reason', payload.get('status'))}")
