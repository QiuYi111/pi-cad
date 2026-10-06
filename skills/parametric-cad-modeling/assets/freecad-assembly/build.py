"""Build two parts, link them in an assembly, edit a part, sweep the joint. Run in the IPython kernel."""
import json
from pathlib import Path

asset = Path("skills/parametric-cad-modeling/assets/freecad-assembly")
ops = lambda name: json.loads((asset / name).read_text())

# Each part is its own document (in a real task, each subagent owns one).
base = await cad.part.open("parts/base.FCStd", create=True, body="base")
await base.apply(ops("base.ops.json"))
link = await cad.part.open("parts/link.FCStd", create=True, body="link")
await link.apply(ops("link.ops.json"))

# The parent owns the assembly document and links the parts.
arm = await cad.part.open("assembly/arm.FCStd", create=True, body="arm")
await arm.apply(ops("assembly.ops.json"))

# A part changes in its own document; the next apply on the assembly picks it up.
await base.apply([{"op": "set", "target": "base/plate", "prop": "Length", "value": 10}])
result = await arm.apply([{"op": "param", "name": "j1_angle", "value": 20}])
print(result.features["recomputed"])      # includes 'arm/base'

# Sweep the joint and show the worst pose.
await arm.sweep("arm/j1", (-90, 90), step=10, check=("clearance", {"a": "arm/link", "b": "arm/base"}))
