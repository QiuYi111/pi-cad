"""Single part fixture: holes, a chamfered mounting face, a bearing seat, an axis, a datum.

The declarations describe engineering meaning only.  Every selector names a
rule that is checked against the *exported* STEP, so the fixture exercise
survives the round trip rather than trusting the in-memory build graph.
"""

from __future__ import annotations

import build123d as bd

DEFAULTS = {
    "plate_length": 60.0,
    "plate_width": 40.0,
    "plate_t": 6.0,
    "hole_d": 5.0,
    "boss_d": 16.0,
    "boss_h": 10.0,
    "chamfer": 1.0,
    "hole_x": 22.0,
    "hole_y": 12.0,
    "include_boss": True,
    "boss_count": 1,
}

HOLE_XY = ((-22.0, -12.0), (22.0, -12.0), (22.0, 12.0), (-22.0, 12.0))
BOSS_SPACING = 20.0


def build(parameters=None):
    values = dict(DEFAULTS)
    values.update(parameters or {})
    length = values["plate_length"]
    width = values["plate_width"]
    thickness = values["plate_t"]
    hole_r = values["hole_d"] / 2.0
    boss_r = values["boss_d"] / 2.0
    chamfer = values["chamfer"]
    hole_xy = (
        (-values["hole_x"], -values["hole_y"]),
        (values["hole_x"], -values["hole_y"]),
        (values["hole_x"], values["hole_y"]),
        (-values["hole_x"], values["hole_y"]),
    )

    plate = bd.Box(length, width, thickness, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    for x, y in hole_xy:
        plate -= bd.Pos(x, y, -1.0) * bd.Cylinder(
            hole_r, thickness + 2.0, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)
        )
    boss = bd.Pos(0, 0, thickness) * bd.Cylinder(
        boss_r, values["boss_h"], align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)
    )
    part = plate
    if values["include_boss"]:
        for index in range(int(values["boss_count"])):
            offset = index * BOSS_SPACING
            part = part + bd.Pos(offset, 0, thickness) * bd.Cylinder(
                boss_r, values["boss_h"], align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)
            )

    top_outline = [
        edge
        for edge in part.edges().filter_by(bd.GeomType.LINE)
        if abs(edge.center().Z - thickness) < 1e-9
    ]
    if top_outline and chamfer > 0:
        part = bd.chamfer(top_outline, length=chamfer)
    boss_top = part.edges().filter_by(bd.GeomType.CIRCLE).group_by(bd.Axis.Z)[-1]
    if chamfer > 0 and values["include_boss"]:
        part = bd.chamfer(boss_top, length=chamfer)

    identity = Assembly("plate")
    identity.instance("plate/base", label="底板", shape=part)
    identity.faces(
        "plate/mount_holes",
        owner="plate/base",
        label="安装孔",
        selector={"entity": "face", "type": "cylinder", "axisDirection": [0, 0, 1], "radius": hole_r},
        expect=4,
    )
    identity.feature(
        "plate/bearing_seat",
        owner="plate/base",
        kind="bearing_seat",
        label="轴承座面",
        selector={"entity": "face", "type": "cylinder", "axisDirection": [0, 0, 1], "radius": boss_r},
        expect=1,
    )
    identity.feature(
        "plate/top_face",
        owner="plate/base",
        kind="mounting_face",
        label="顶面",
        selector={"entity": "face", "type": "plane", "normal": [0, 0, 1], "centroid": [0, 0, thickness]},
        expect=1,
    )
    identity.feature(
        "plate/bottom_face",
        owner="plate/base",
        kind="mounting_face",
        label="底面",
        selector={"entity": "face", "type": "plane", "normal": [0, 0, -1], "centroid": [0, 0, 0]},
        expect=1,
    )
    identity.axis(
        "plate/boss_axis",
        owner="plate/base",
        label="轴承座轴线",
        origin=[0, 0, thickness],
        direction=[0, 0, 1],
        coordinate="local",
    )
    identity.datum(
        "plate/top_frame",
        owner="plate/base",
        label="顶面基准",
        origin=[0, 0, thickness],
        zAxis=[0, 0, 1],
        xAxis=[1, 0, 0],
        coordinate="local",
    )
    return part


result = build()
