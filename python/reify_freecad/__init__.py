"""FreeCAD part backend for Pi-CAD.

Runs inside the FreeCAD conda environment (``<env>/bin/python -m
reify_freecad.worker``). Modules that touch FreeCAD import it at the top;
the rest (``errors``, ``naming``, ``exprs``, ``fingerprint``, ``summary``,
``ops.schema``) are pure Python so the uv environment can test them.

Never import build123d or OCP here: the two environments carry different
OpenCascade builds and only exchange files (STEP, JSON).
"""

PROTOCOL_VERSION = 1
