# Identity: naming parts, instances, features, and datums

Full protocol: `docs/identity-protocol.md`.

A semantic path (`arm/forearm/j3_bearing_seat`) is the stable name of one
engineering object. A display label (`J3 轴承座`) is presentation and may
repeat. An artifact ref (`occ-…`, `surf-…`) is a handle into one STEP version
and dies with it.

## When the model declares names

`cadctl build` writes `<step>.identity.json` next to the STEP whenever the
model declares an `Assembly` (it is preloaded into the model namespace). A
model that only exposes a `Shape` keeps building with no manifest.

```python
identity = Assembly("hifi-arm")
identity.instance("arm/forearm", label="前臂", shape=forearm)
identity.feature(
    "arm/forearm/j3_bearing_seat", owner="arm/forearm", kind="bearing_seat",
    selector={"entity": "face", "type": "cylinder", "radius": 8.0}, expect=1,
)
identity.axis("arm/j3/axis", owner="arm", origin=[0, 0, 0], direction=[0, 1, 0])
```

Selectors are checked against the exported STEP after the build, so a deleted
face or an ambiguous match fails the build instead of binding the wrong object.

## When you only consume an artifact

```bash
cadctl identity list    --artifact arm.step --kind feature
cadctl identity resolve --artifact arm.step --target arm/forearm/j3_bearing_seat --expect one
cadctl identity verify  --artifact arm.step
```

```python
from cadctl.identity import IdentityIndex

index = IdentityIndex("arm.step")
index.resolve("arm/forearm/j3_bearing_seat", expect="one")
index.resolve("surf-fa965204fa")
```

## Rules

- Resolve by path, by current ref, or by kind/owner filter. Never by array
  position; `solidIndex` is an internal mapping bound to the artifact hash.
- One match is not assumed. `expect="one"` fails on several matches, and every
  answer reports the artifact hash it came from.
- A ref from an earlier build is refused (`unknown-ref`). Re-inspect the
  artifact, or rebuild from source.
- An artifact with no manifest resolves only current-version refs
  (`stable = false`). It has no stable names to give.
- A name is a handle. It is not evidence that a requirement passed.
