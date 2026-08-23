from __future__ import annotations

import argparse
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--domain", type=Path, required=True)
parser.add_argument("--materials", type=Path, required=True)
parser.add_argument("--surface-mapping", type=Path, required=True)
parser.add_argument("--rev1-spec-pack", type=Path, required=True)
args = parser.parse_args()
target = Path(__file__).parent / ".ignored-benchmark-inputs"
target.mkdir(exist_ok=True)
for source, name in [(args.domain, "domain.step"), (args.materials, "materials.json"), (args.surface_mapping, "surface-mapping.json")]:
    if not source.is_file():
        raise SystemExit(f"missing authoritative input: {source}")
    shutil.copy2(source, target / name)
for source, name in [(args.rev1_spec_pack, "rev1-spec-pack")]:
    if not source.is_dir():
        raise SystemExit(f"missing authoritative input directory: {source}")
    destination = target / name
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination)
criteria = target / "rev1-spec-pack" / "release-criteria.json"
if not criteria.is_file():
    raise SystemExit(f"Rev1 spec pack must contain {criteria.name}")
print(f"Prepared ignored SPEC-04 inputs in {target}")
