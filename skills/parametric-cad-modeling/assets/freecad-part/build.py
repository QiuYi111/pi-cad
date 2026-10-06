"""Build and edit the bracket with cad.part. Run in the persistent IPython kernel (it uses await)."""
import json
from pathlib import Path

asset = Path("skills/parametric-cad-modeling/assets/freecad-part")
doc = await cad.part.open("parts/bracket.FCStd", create=True, body="bracket")
first = await doc.apply(json.loads((asset / "part.ops.json").read_text()), message="plate with four holes")
print(first)                      # PartResult(rev=1, ...); the seven views are attached
second = await doc.apply(json.loads((asset / "edit.ops.json").read_text()))
print(second.params)              # {'hole_d': [6.0, 8.0]}
await doc.query("bracket/mount_hole/wall", ["faces"])
