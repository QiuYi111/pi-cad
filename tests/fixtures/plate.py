from build123d import Box, BuildPart, Cylinder, Locations, Mode

with BuildPart() as plate:
    Box(100, 80, 5)
    with Locations((40, 30), (-40, 30), (40, -30), (-40, -30)):
        Cylinder(3, 10, mode=Mode.SUBTRACT)

result = plate.part
