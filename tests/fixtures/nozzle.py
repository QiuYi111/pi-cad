"""Converging-diverging nozzle fluid domain (walking-skeleton flow fixture).

The solid IS the fluid volume: inlet plane at x=0, throat at x=120 mm
(r=25 mm), outlet plane at x=320 mm (r=40 mm). All dimensions in mm.
"""
from build123d import Axis, BuildLine, BuildPart, BuildSketch, Line, make_face, revolve

PROFILE = [
    (0.0, 50.0),
    (60.0, 50.0),
    (120.0, 25.0),
    (300.0, 40.0),
    (320.0, 40.0),
]

with BuildPart() as nozzle:
    with BuildSketch() as sk:
        with BuildLine() as ln:
            for (x1, r1), (x2, r2) in zip(PROFILE, PROFILE[1:]):
                Line((x1, r1), (x2, r2))
            Line((PROFILE[-1][0], PROFILE[-1][1]), (PROFILE[-1][0], 0.0))
            Line((PROFILE[-1][0], 0.0), (PROFILE[0][0], 0.0))
            Line((PROFILE[0][0], 0.0), (PROFILE[0][0], PROFILE[0][1]))
        make_face()
    revolve(axis=Axis.X)

result = nozzle.part
