# External benchmark inputs

This directory is intentionally ignored except for this file. Run
`uv run --project python python benchmarks/simulation-v2/spec04-template/prepare_inputs.py --domain ... --materials ... --surface-mapping ... --rev1-spec-pack ...`
to import authoritative local inputs. Do not vendor Downloads or private
material data into the repository. No generated OpenFOAM project case is an
input: the repository-owned Recipe creates it deterministically.
