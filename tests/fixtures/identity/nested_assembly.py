"""Nested assembly fixture: repeated parts, identical instances, multi-solid part.

Covers the cases the old ordinal `occ-*` scheme got wrong:

* two instances of one part definition, placed at different positions and
  carrying the *same* display label;
* one named part that contains more than one solid;
* two instances whose geometry is identical in shape.
"""

from __future__ import annotations

import build123d as bd

DEFAULTS = {
    "pin_d": 4.0,
    "pin_h": 10.0,
    "spacer": False,
    "reverse_order": False,
}

MIN = (bd.Align.MIN, bd.Align.MIN, bd.Align.MIN)


def _bracket(x: float):
    """One bracket, already placed in world coordinates.

    Every body carries its own placement, so the shape an author hands to a
    declaration already describes where the body ends up in the export.
    """
    base = bd.Pos(x, 0, 0) * bd.Box(20, 20, 4, align=MIN)
    rib = bd.Pos(x, 0, 4) * bd.Box(4, 20, 16, align=MIN)
    return base, rib, bd.Compound(children=[base, rib])


def _pin(radius, height):
    return bd.Cylinder(radius, height, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))


def build(parameters=None):
    values = dict(DEFAULTS)
    values.update(parameters or {})
    pin_r = values["pin_d"] / 2.0

    left_base, left_rib, left = _bracket(0.0)
    right_base, right_rib, right = _bracket(40.0)
    pin_a = bd.Pos(8, 0, 20) * _pin(pin_r, values["pin_h"])
    pin_b = bd.Pos(48, 0, 20) * _pin(pin_r, values["pin_h"])

    sub = bd.Compound(children=[left, pin_a])
    members = [sub, right, pin_b]
    if values["spacer"]:
        members.append(bd.Pos(70, 0, 0) * bd.Box(4, 4, 4, align=MIN))
    if values["reverse_order"]:
        members = list(reversed(members))
    assembly = bd.Compound(children=members)

    identity = Assembly("arm")
    identity.part("arm/bracket_def", label="支座")
    identity.part("arm/pin_def", label="销")
    identity.instance("arm/bracket_left", part="arm/bracket_def", label="支座", shape=left)
    identity.instance("arm/bracket_right", part="arm/bracket_def", label="支座", shape=right)
    identity.solid("arm/bracket_left/base", owner="arm/bracket_left", label="底板", shape=left_base)
    identity.solid("arm/bracket_left/rib", owner="arm/bracket_left", label="筋板", shape=left_rib)
    identity.solid("arm/bracket_right/base", owner="arm/bracket_right", label="底板", shape=right_base)
    identity.solid("arm/bracket_right/rib", owner="arm/bracket_right", label="筋板", shape=right_rib)
    identity.instance("arm/pin_a", part="arm/pin_def", label="销", shape=pin_a)
    identity.instance("arm/pin_b", part="arm/pin_def", label="销", shape=pin_b)
    identity.axis(
        "arm/pin_a/hole_axis",
        owner="arm/pin_a",
        label="销孔轴线",
        origin=[0, 0, 0],
        direction=[0, 0, 1],
        coordinate="local",
    )
    identity.faces(
        "arm/bracket_left/rib_face",
        owner="arm/bracket_left",
        label="筋板侧面",
        selector={"entity": "face", "type": "plane", "normal": [0, 0, 1], "centroid": [2, 10, 20]},
        expect=1,
    )
    return assembly


result = build()
