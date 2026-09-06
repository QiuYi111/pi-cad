#!/usr/bin/env python3
"""Inspect the supported desktop simulation format: ASCII VTK XML .vtu."""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path
from xml.etree import ElementTree as ET


def values(node: ET.Element) -> list[float]:
    if node.get("format", "ascii") != "ascii":
        raise ValueError("Only ASCII DataArray values are supported in the embedded result inspector.")
    return [float(value) for value in (node.text or "").split()]


def main() -> None:
    source = Path(sys.argv[1]).resolve(strict=True)
    if source.suffix.lower() != ".vtu":
        raise ValueError("Embedded result inspection currently supports ASCII VTK XML .vtu files.")
    root = ET.parse(source).getroot()
    piece = root.find(".//Piece")
    if piece is None:
        raise ValueError("VTU file has no UnstructuredGrid Piece.")
    points_array = piece.find("./Points/DataArray")
    if points_array is None:
        raise ValueError("VTU file has no point coordinates.")
    coordinates = values(points_array)
    if len(coordinates) % 3:
        raise ValueError("VTU point coordinates are not 3-component tuples.")
    axes = [coordinates[index::3] for index in range(3)]
    bounds = {axis: [min(items), max(items)] for axis, items in zip("xyz", axes)}
    fields = []
    for association, parent in (("point", piece.find("./PointData")), ("cell", piece.find("./CellData"))):
        if parent is None:
            continue
        for array in parent.findall("./DataArray"):
            name = array.get("Name") or "unnamed"
            data = values(array)
            components = int(array.get("NumberOfComponents", "1"))
            finite = [value for value in data if math.isfinite(value)]
            unit_match = re.search(r"\[([^\]]+)\]$", name)
            fields.append({"name": name, "association": association, "components": components,
                           "min": min(finite) if finite else None, "max": max(finite) if finite else None,
                           "unit": array.get("Unit") or (unit_match.group(1) if unit_match else None)})
    model_source = None
    for array in piece.findall("./FieldData/DataArray"):
        if array.get("Name") == "model_source":
            model_source = (array.text or "").strip() or None
    print(json.dumps({"format": "VTK XML UnstructuredGrid (.vtu, ASCII)", "source": str(source),
                      "pointCount": int(piece.get("NumberOfPoints", len(coordinates) // 3)),
                      "cellCount": int(piece.get("NumberOfCells", "0")), "bounds": bounds,
                      "fields": fields, "modelSource": model_source}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
