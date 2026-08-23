from __future__ import annotations

import json
import os
from pathlib import Path

from cadctl.simulation.api import run_simulation


root = Path(__file__).resolve().parent
spec = json.loads((root / "case.json").read_text(encoding="utf-8"))
accelerator = os.environ.get("PI_SIM_ACCELERATOR")
if accelerator not in {"cuda", "cpu"}:
    raise SystemExit("PI_SIM_ACCELERATOR must be supplied by a managed torch-fem runtime")
spec["device"] = accelerator
(root / "resolved-case.json").write_text(json.dumps(spec, indent=2), encoding="utf-8")
payload = run_simulation(root / "resolved-case.json", root / "results")
if payload.get("status") != "solved":
    raise SystemExit(f"torch-fem solve failed: {payload}")
if payload.get("actualDevice") != accelerator:
    raise SystemExit(f"accelerator mismatch: requested {accelerator}, got {payload.get('actualDevice')}")
(root / "result.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
