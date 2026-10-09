"""Two independently named STEP occurrences with nested bounding boxes."""

import build123d as bd

outer = bd.Box(20, 20, 20)
inner = bd.Pos(5, 5, 5) * bd.Box(4, 4, 4)
result = bd.Compound(children=[outer, inner])

identity = Assembly("case")
identity.instance("case/outer", shape=outer)
identity.instance("case/inner", shape=inner)
