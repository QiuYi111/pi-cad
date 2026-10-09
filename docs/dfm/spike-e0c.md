# Spike E0-c: cut diameter of FreeCAD threaded holes (M2 to M12)

Question (plan §3, E0-c): with a `hole` op that has `thread`, which diameter does FreeCAD actually cut,
and does it match the 铨洲 tap-drill table (plan §5 table H3, `tables.tap_drill_mm`)?

## Method

- Script: `tests/freecad/dfm_spike_e0c.py` (not a test; run with the FreeCAD Python, see its docstring).
- FreeCAD 1.1.0 (20260325) in `~/.local/share/pi-cad/runtimes/freecad/env`, through the real `Worker`.
- Part: 40 x 30 x 10 mm plate, one blind hole, depth 7.5 mm, from the top face, with
  `{"op": "hole", "diameter": D, "depth": 7.5, "thread": "<size>"}` (`ModelThread` false, the op default).
- Measured: the solid is sliced at mid depth (z = 6 mm, inside the hole). The inner loop is discretised
  (720 points) and its distance from the hole axis gives the cut radius. A straight cylinder gives min = max.
- Two diameter arguments per size: the tap drill (what the conclusion recommends) and the nominal size
  (what a naive op writes). The M3 row with `ModelThread` true sets the property after the apply and
  recomputes.

## Result

Cut diameter with `ModelThread` false:

| size | ThreadSize (FreeCAD) | op `diameter` | FreeCAD `Diameter` after apply (mm) | measured cut (mm) | 铨洲 tap drill (mm) | measured - tap drill (mm) |
|---|---|---|---|---|---|---|
| M2 | M2x0.4 | 1.6 | 1.6 | 1.600 | 1.6 | 0.000 |
| M2.5 | M2.5x0.45 | 2.05 | 2.05 | 2.050 | 2.05 | 0.000 |
| M3 | M3x0.5 | 2.5 | 2.5 | 2.500 | 2.5 | 0.000 |
| M4 | M4x0.7 | 3.3 | 3.3 | 3.300 | 3.3 | 0.000 |
| M5 | M5x0.8 | 4.2 | 4.2 | 4.200 | 4.2 | 0.000 |
| M6 | M6x1.0 | 5.0 | 5.0 | 5.000 | 5.0 | 0.000 |
| M8 | M8x1.25 | 6.8 | 6.8 | 6.800 | 6.8 | 0.000 |
| M10 | M10x1.5 | 8.5 | 8.5 | 8.500 | 8.5 | 0.000 |
| M12 | M12x1.75 | 10.2 | 10.2 | 10.200 | 10.2 | 0.000 |

The same table with the nominal size as the op `diameter` (M2 2.0, M2.5 2.5, M3 3.0, M4 4.0, M5 5.0,
M6 6.0, M8 8.0, M10 10.0, M12 12.0) gives the same result for every size: the stored `Diameter` and the
cut are the tap drill, and the difference is 0.000 mm. The op's `diameter` is replaced when `thread` is set.

Modelled thread (`ModelThread` true), M3 only, `diameter` 2.5:

| size | FreeCAD `Diameter` (mm) | measured min (mm) | measured max (mm) | min - tap drill (mm) |
|---|---|---|---|---|
| M3, modelled | 2.52 | 2.520 | 3.020 | +0.020 |

The modelled thread is a helical profile between 2.52 and 3.02 mm. It is not a drilled hole of 2.5 mm,
which is why `hole.thread_modeled` (warn) stays in the rulepack.

Raw rows: `tests/freecad/dfm_spike_e0c.py` prints them; the run on this checkout reproduces the values above.

## Conclusion

1. FreeCAD's `thread` on a plain `hole` (ISO metric, `ModelThread` false) cuts exactly the 铨洲 tap drill for
   all nine sizes M2 to M12 (difference 0.000 mm). The thread is metadata only (`Threaded` true).
2. The `diameter` of the op is ignored when `thread` is set: FreeCAD replaces `Diameter` with the tap drill of
   the thread size. An agent that writes `diameter: 3` with `thread: "M3"` gets a 2.5 mm cut and no error.
   The lint must therefore read the stored `Diameter`, not the op value.
3. The op an agent should write for an M3 tapped hole is:

   ```json
   {"op": "hole", "name": "bracket/m3_tap", "sketch": "bracket/holes", "diameter": 2.5, "thread": "M3", "type": "through_all"}
   ```

   Writing `diameter: 2.5` explicitly makes the intent visible and matches the stored value. A plain hole with
   `diameter: 2.5` and no `thread` gives the same cut (checked separately: 2.500 mm); the thread name then goes in the feature name
   (plan §8). Use the tap drill in the `diameter` field, never the nominal size.
4. Do not use `ModelThread` (`model_thread: true`): it gives a 2.52 to 3.02 mm profile. The rulepack keeps
   `hole.thread_modeled` as warn.
5. The wrong-tap fixture needs `set Diameter` after the thread (`set` accepts `Diameter`), because a
   `diameter` in the `hole` op cannot produce a wrong tap. `tests/fixtures/dfm/wrong_tap` cuts 2.4 mm
   (checked on the cut section).

## Consequence for the plan

- `hole.thread_tap_drill` (error) checks the stored `Diameter` against `tables.tap_drill_mm` (±0.05). With
  the current backend a `thread` hole always passes; a wrong tap needs a plain hole or a `set Diameter`.
- The Q-H3 hint can say: "M3 tap drill is φ2.5 (FreeCAD cuts φ2.5 for thread M3 with diameter 2.5)" and
  "use diameter 2.5 with thread M3; do not model the thread".
- No change to the tap-drill table: the 铨洲 values in `tables.tap_drill_mm` match FreeCAD's tap drills for
  M2 to M12.
