from __future__ import annotations

import argparse
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cadctl.cli import build_parser
from picad_sim import export


class SimulationV2HelperTests(unittest.TestCase):
    def test_observation_export_helper_writes_wire_schema(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "observation.json"
            with patch.dict(os.environ, {"PI_SIM_OBSERVATION_FILE": str(destination)}):
                written = export({"opaque_metric": {"type": "scalar", "value": 1.25, "unit": "1"}})
            self.assertEqual(written, destination)
            self.assertEqual(json.loads(destination.read_text(encoding="utf-8")), {
                "schema": 1,
                "exports": {"opaque_metric": {"type": "scalar", "value": 1.25, "unit": "1"}},
            })

    def test_legacy_typed_simulation_cli_commands_are_absent(self) -> None:
        parser = build_parser()
        subparsers = next(action for action in parser._actions if isinstance(action, argparse._SubParsersAction))
        self.assertNotIn("simulate", subparsers.choices)
        self.assertNotIn("simulate-flow", subparsers.choices)
        self.assertNotIn("simulate-thermal", subparsers.choices)


if __name__ == "__main__":
    unittest.main()
