from __future__ import annotations

import sys

import cadquery as cq


def main() -> None:
    source, destination, factor_text = sys.argv[1:4]
    factor = float(factor_text)
    if not factor > 0:
        raise ValueError("scale factor must be positive")
    imported = cq.importers.importStep(source)
    scaled = imported.val().scale(factor)
    cq.exporters.export(scaled, destination)


if __name__ == "__main__":
    main()
