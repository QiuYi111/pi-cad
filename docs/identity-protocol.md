# Identity protocol v1

One name for one engineering object, from authoring to inspection.

Authors and tools need to say "the J3 bearing seat cylinder of the forearm" and
mean the same thing after a rebuild. Traversal order, display order, and array
positions cannot carry that meaning, because any of them can change while the
part stays the same.

## Three layers

| Layer | Example | Changes when | Carries meaning |
| --- | --- | --- | --- |
| Semantic path | `arm/forearm/j3_bearing_seat` | the author renames the object | yes — stable across rebuilds |
| Display label | `J3 轴承座`, `forearm` | wording or language changes | no — mutable, may repeat |
| Artifact ref | `occ-75028899bcc7-0.1`, `surf-fa965204fa` | the artifact bytes change | no — bound to one STEP version |

A path is an identity. A label is presentation. A ref is a handle into the
current geometry. Nothing lets a label override a path, and nothing lets a ref
outlive the artifact it was computed from.

## Path syntax

A path is one or more segments joined by `/`. Segments are compared in
canonical form:

- NFC-normalised UTF-8, so `café` written two ways is one path;
- `/` inside a name is escaped as `%2F` and `%` as `%25`; these are the only
  escapes, any other `%XX` is an error;
- a segment may not be empty, `.`, `..`, a control character, or a bare
  number. A bare number would read as an array position, which is not an
  identity.

```text
arm/forearm                     two segments, one part instance
arm/forearm/j3_bearing_seat     a feature inside that instance
arm/j3/axis                     a datum axis, not a body
arm/a%2Fb                       one segment whose name contains a slash
前臂/轴承座                       Chinese segments are fine
```

Two declarations with the same canonical path are a build error, so
`arm%2Fleft` (one segment) and `arm/left` (two segments) coexist while one
segment spelled two ways does not.

## Declaring meaning in a model

Declaration is optional. A model that only exposes a build123d `Shape` keeps
building, and its artifact simply has no semantic manifest.

```python
import build123d as bd

# Assembly is preloaded into the model namespace by the build.
identity = Assembly("hifi-arm")

identity.part("arm/bracket_def", label="支座")
identity.instance("arm/bracket_left", part="arm/bracket_def", label="支座", shape=left)
identity.solid("arm/bracket_left/base", owner="arm/bracket_left", label="底板", shape=left_base)

identity.feature(
    "arm/forearm/j3_bearing_seat",
    owner="arm/forearm",
    kind="bearing_seat",
    label="J3 轴承座",
    selector={"entity": "face", "type": "cylinder", "radius": 8.0},
    expect=1,
)
identity.faces(
    "arm/forearm/mount_holes",
    owner="arm/forearm",
    label="安装孔",
    selector={"entity": "face", "type": "cylinder", "axisDirection": [0, 0, 1], "radius": 2.5},
    expect=4,
)
identity.axis("arm/j3/axis", owner="arm", label="J3 轴", origin=[0, 0, 0], direction=[0, 1, 0])
identity.datum("arm/base_frame", owner="arm", origin=[0, 0, 0], zAxis=[0, 0, 1], xAxis=[1, 0, 0])

result = part
```

Entity kinds: `assembly`, `part`, `instance`, `solid`, `feature`, `faces`,
`edges`, `axis`, `datum`. A part definition (`part`) is separate from a
placement (`instance`), so the same part installed twice has two instance paths
and two occurrence refs.

An `instance` or `solid` declared with `shape=` is bound in the exported STEP
by exact bounds and volume for one solid, or by exact bounds and volume for
each member of a multi-solid shape. Each member must resolve exactly once. A
node declared with no selector is a grouping container; it owns whatever its
descendants bind.

## Selectors

A selector is a deterministic rule evaluated against the **exported** STEP, not
against the in-memory build graph:

| Entity | Predicates |
| --- | --- |
| `solid` | `near`, `withinBounds`, `volume`, `bounds`, `extreme` (`axis`, `side`) |
| `face` | `type`, `normal`, `axisDirection`, `radius`, `area`, `centroid` |
| `edge` | `type`, `length`, `radius`, `centroid` |

Every numeric predicate is compared within `tolerance` (default `1e-6`).
Selection is bounded on purpose: a shape that moved or disappeared produces "no
candidate" instead of a nearest guess. Face normals are matched exactly, while
cylinder and cone axis directions are matched up to sign, because STEP does not
promise an orientation.

`expect` states the required match count: an integer, `one`, `many`, or
`{"min": n, "max": m}`. `faces` and `edges` default to `many`, everything else
defaults to `1`. A build fails when the count does not hold, so a boolean that
deletes a face or splits it into two candidates is caught instead of silently
binding the wrong object.

Feature meaning is declared, never inferred: the protocol never decides that a
cylinder "is" a bearing seat. The author writes `kind="bearing_seat"` and then
binds it to final geometry.

## What a build writes

`cadctl build` writes `foo.step.identity.json` next to `foo.step`:

```json
{
  "protocol": "reify-identity",
  "version": 1,
  "artifact": {"path": "...", "sha256": "...", "units": "mm"},
  "build": {"sourceFiles": [], "sourceClosureHash": "...", "parameters": {}, "parametersHash": "..."},
  "entities": [
    {"path": "arm/forearm/j3_bearing_seat", "kind": "feature", "owner": "arm/forearm",
     "featureKind": "bearing_seat", "bindings": [{"ref": "surf-...", "solidIndex": 3}]}
  ],
  "refs": {"surf-...": ["arm/forearm/j3_bearing_seat"]},
  "counts": {"feature": 1, "instance": 2}
}
```

`refs` maps each geometry ref to every semantic path that directly binds it.
Resolving a ref that has several paths fails with `ambiguous-ref`; resolve a
semantic path to choose the intended meaning. Grouping containers are omitted
from this reverse index.

Bindings name real objects in the exported STEP and record the facts used to
find them: kind, owner occurrence, area or volume, and local plus world
placement for axes and datums. Build-time Python object names are never stored
as a binding.

## Resolving

```python
from cadctl.identity import IdentityIndex

index = IdentityIndex("arm.step")           # verifies manifest against artifact
seat = index.resolve("arm/forearm/j3_bearing_seat", expect="one")
holes = index.resolve("arm/forearm/mount_holes", kind="faces")
same = index.resolve("surf-fa965204fa")     # by current artifact ref
index.entities(kind="feature", owner="arm/forearm")
index.verify()
```

```bash
cadctl identity resolve --artifact arm.step --target arm/forearm/j3_bearing_seat --expect one
cadctl identity list    --artifact arm.step --kind feature --owner arm/forearm
cadctl identity verify  --artifact arm.step
```

Every result carries the semantic path, entity kind, owner, current artifact
refs, the actual artifact hash, and whether the name is stable. Errors are
stable codes, not prose to match on:

| Code | Meaning | What to do |
| --- | --- | --- |
| `malformed-path` | the path is not canonical | fix the spelling, escape the separator |
| `unknown-path` | this artifact declares no such path | list `entities`, pick a real one |
| `unknown-ref` | the ref belongs to another version | re-inspect the current artifact |
| `stale-artifact` | the manifest does not belong to these bytes | rebuild the model |
| `no-manifest` | the artifact has no declared names | rebuild with a declared `Assembly` |
| `wrong-kind`, `wrong-owner` | the query contradicts the declaration | ask for the right object |
| `cardinality` | the requested count does not hold | narrow the selector or fix `expect` |

The resolver never returns the first of several matches on its own.

## Compatibility

- `occ-*`, `surf-*`, and anonymous STEP artifacts keep working. Without a
  manifest they resolve only as current-version refs and report
  `stable = false`; a ref from another version is refused.
- A legacy `foo.step.assembly.json` (schema 1) is still read and migrated: its
  part ids resolve with `source = "legacy"` and `stable = false`. When it
  declares `artifactHash`, a mismatch is refused.
- Writing an identity manifest removes a stale legacy sidecar next to the same
  STEP, so an unbound name set cannot masquerade as the new model. A manifest
  whose artifact hash does not match the file on disk is refused by both the
  resolver and the mesh document.
- Array indices appear only as `solidIndex`, an internal mapping bound to the
  artifact hash. They are never offered as an outward-stable identity.

## Out of scope

General topological naming across arbitrary boolean history, CAD feature
recognition, purchase-part identification, a new database service, forcing
every design into a detailed feature tree, and migrating existing
Viewer/Blender/Probe call sites. A geometric name is a reliable handle, not
evidence that an engineering requirement passed.
