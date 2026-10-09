"""Runs the ``reify-asi`` analyzer (Analysis Situs, OCCT 7.6) in its own process (pure Python).

``find_reify_asi`` honours ``PI_CAD_ASI_BIN`` first. An explicit path that does not exist
disables the analyzer (no fallback to the installed copy), so tests can force the built-in
path. Without the variable the bootstrap location is used (``PI_CAD_ASI_HOME`` or
``$XDG_DATA_HOME/pi-cad/runtimes/asi`` or ``~/.local/share/pi-cad/runtimes/asi``).
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from ..errors import ReifyOpError

STDERR_TAIL = 2000
DEFAULT_THICKNESS_SAMPLES = 64


def find_reify_asi() -> Path | None:
    explicit = os.environ.get("PI_CAD_ASI_BIN")
    if explicit:
        path = Path(explicit)
        return path if path.is_file() and os.access(path, os.X_OK) else None
    home = os.environ.get("PI_CAD_ASI_HOME")
    if not home:
        data = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        home = str(Path(data) / "pi-cad" / "runtimes" / "asi")
    path = Path(home) / "bin" / "reify-asi"
    return path if path.is_file() else None


def _tail(text: Any) -> str:
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    return (text or "")[-STDERR_TAIL:]


def run_asi(brep: Path, checks: list[str], timeout_s: float, *, thickness_samples: int = DEFAULT_THICKNESS_SAMPLES) -> dict[str, Any]:
    """Analyze one ``.brep`` file; returns the parsed JSON. Raises ``DFM_ANALYZER_FAILED`` on any failure."""
    binary = find_reify_asi()
    if binary is None:
        raise ReifyOpError("DFM_ANALYZER_FAILED", "reify-asi is not installed", detail={"stderr": ""})
    with tempfile.TemporaryDirectory(prefix="reify-asi-") as scratch:
        out = Path(scratch) / "result.json"
        argv = [str(binary), "analyze", "--in", str(brep), "--out", str(out), "--checks", ",".join(checks)]
        if "thickness" in checks:
            argv += ["--thickness-samples", str(int(thickness_samples))]
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=max(float(timeout_s), 0.05), check=False)
        except subprocess.TimeoutExpired as error:
            raise ReifyOpError("DFM_ANALYZER_FAILED", f"reify-asi did not finish in {timeout_s:.1f} s",
                               detail={"stderr": _tail(error.stderr), "reason": "timeout"}) from error
        except OSError as error:
            raise ReifyOpError("DFM_ANALYZER_FAILED", f"reify-asi cannot start: {error}", detail={"stderr": ""}) from error
        if proc.returncode != 0:
            raise ReifyOpError("DFM_ANALYZER_FAILED", f"reify-asi exited with code {proc.returncode}",
                               detail={"stderr": _tail(proc.stderr), "exitCode": proc.returncode})
        try:
            return json.loads(out.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ReifyOpError("DFM_ANALYZER_FAILED", f"reify-asi wrote no readable result: {error}",
                               detail={"stderr": _tail(proc.stderr)}) from error
