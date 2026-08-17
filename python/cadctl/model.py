from __future__ import annotations

import contextlib
import io
import sys
import traceback
from pathlib import Path

import build123d as bd

_writes: list[Path] = []


def reset_writes() -> None:
    _writes.clear()


def gen_step(shape: bd.Shape, file_path: str | Path | None = None) -> str:
    """Deterministic STEP exporter used by generated user models.

    This is the only blessed way for a generated model to ask for a STEP
    sidecar.  V0 also supports the simpler ``result = part.part`` protocol
    used by ``cadctl build --output``.
    """
    if file_path is None:
        raise ValueError("gen_step requires an explicit output path")
    out = Path(file_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    bd.export_step(shape, str(out))
    _writes.append(out)
    return str(out)


def run_source(source: str | Path, output: str | Path | None = None, cwd: str | Path | None = None) -> dict:
    source = Path(source)
    cwd = Path(cwd) if cwd else Path.cwd()
    if not source.exists():
        raise FileNotFoundError(f"source does not exist: {source}")

    output_path = Path(output) if output else None
    reset_writes()
    old_cwd = Path.cwd()
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        if cwd != old_cwd:
            import os

            os.chdir(cwd)
        sys.path.insert(0, str(cwd))

        namespace: dict = {
            "__name__": "__pi_cad_user_model__",
            "__file__": str(source),
            "gen_step": gen_step,
        }

        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = compile(source.read_text(encoding="utf-8"), str(source), "exec")
            exec(code, namespace)  # noqa: S102 - intentional CAD model execution

        result = namespace.get("result")
        if result is None:
            result = namespace.get("part")

        wrote_requested_output = bool(output_path and output_path in _writes)
        if result is not None:
            if not isinstance(result, bd.Shape):
                raise TypeError("generated model 'result' must be a build123d Shape")
            if output_path is not None:
                output_path.parent.mkdir(parents=True, exist_ok=True)
                bd.export_step(result, str(output_path))
                wrote_requested_output = True

        if output_path is None and result is not None:
            # Without --output a result-only model has nowhere deterministic to go.
            raise ValueError("model produced 'result' but no --output path was provided")

        if not wrote_requested_output and output_path is not None:
            raise ValueError(
                "model did not produce the requested STEP output; expose a build123d "
                "Shape as `result` or call gen_step(result, output)"
            )

        if output_path is not None and not output_path.exists():
            raise RuntimeError(f"STEP output was not created: {output_path}")

        return {
            "exitCode": 0,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
        }
    except Exception as exc:  # pragma: no cover - formatted below
        return {
            "exitCode": 1,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue() + "\n" + traceback.format_exc(),
            "error": str(exc),
        }
    finally:
        if cwd != old_cwd:
            import os

            os.chdir(old_cwd)
        if str(cwd) in sys.path:
            sys.path.remove(str(cwd))
