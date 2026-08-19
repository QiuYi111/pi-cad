"""1D-conduction slab (walking-skeleton thermal fixture).

100 x 100 x 500 mm box; the two 100 x 100 end faces carry fixed
temperatures and the analytic axial heat rate is q = k A dT / L.
"""
from build123d import Box, BuildPart

with BuildPart() as slab:
    Box(100, 100, 500)

result = slab.part
