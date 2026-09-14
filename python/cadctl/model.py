from __future__ import annotations

import contextlib
import io
import os
import sys
import traceback
from pathlib import Path
from typing import Any

import build123d as bd

_writes: list[Path] = []


def _track_project_reads(roots: tuple[Path, ...]) -> tuple[set[Path], dict[str, bool]]:
    """Collect files opened by user model code inside its project roots.

    Python audit hooks cannot be removed, so the small mutable switch disables
    this collector after one build. Warm builds execute in fresh forked
    children; direct library callers remain safe as well.
    """
    files: set[Path] = set()
    state = {"active": True}

    def audit(event: str, args: tuple[Any, ...]) -> None:
        if not state["active"] or event != "open" or not args:
            return
        raw = args[0]
        if not isinstance(raw, (str, bytes, os.PathLike)):
            return
        try:
            path = Path(raw).resolve()
        except (OSError, TypeError, ValueError):
            return
        if path.is_file() and any(_is_within(path, root) for root in roots):
            files.add(path)

    sys.addaudithook(audit)
    return files, state


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _source_files(source: Path, roots: tuple[Path, ...], before: set[str]) -> list[str]:
    files = {source.resolve()}
    for name in set(sys.modules) - before:
        module = sys.modules.get(name)
        raw = getattr(module, "__file__", None)
        if not raw:
            continue
        try:
            path = Path(raw).resolve()
        except OSError:
            continue
        if path.suffix == ".py" and any(_is_within(path, root) for root in roots):
            files.add(path)
    return [str(path) for path in sorted(files)]


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


def run_source(
    source: str | Path,
    output: str | Path | None = None,
    cwd: str | Path | None = None,
    parameters: dict[str, Any] | None = None,
) -> dict:
    source = Path(source).resolve()
    cwd = (Path(cwd) if cwd else Path.cwd()).resolve()
    if not source.exists():
        raise FileNotFoundError(f"source does not exist: {source}")

    output_path = Path(output) if output else None
    reset_writes()
    old_cwd = Path.cwd()
    stdout = io.StringIO()
    stderr = io.StringIO()
    before_modules = set(sys.modules)
    source_roots = tuple(dict.fromkeys((cwd, source.parent)))
    accessed_files, audit_state = _track_project_reads(source_roots)
    inserted_paths: list[str] = []
    try:
        if cwd != old_cwd:
            os.chdir(cwd)
        for entry in (str(source.parent), str(cwd)):
            if entry not in sys.path:
                sys.path.insert(0, entry)
                inserted_paths.append(entry)

        namespace: dict = {
            "__name__": "__pi_cad_user_model__",
            "__file__": str(source),
            "gen_step": gen_step,
        }

        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = compile(source.read_text(encoding="utf-8"), str(source), "exec")
            exec(code, namespace)  # noqa: S102 - intentional CAD model execution
            if parameters is not None:
                entrypoint = namespace.get("build")
                if not callable(entrypoint):
                    raise TypeError("parameterized model must expose build(parameters)")
                result = entrypoint(dict(parameters))
            else:
                result = namespace.get("result")
                if result is None:
                    result = namespace.get("part")

        wrote_requested_output = bool(output_path and output_path in _writes)
        if result is not None:
            if not isinstance(result, bd.Shape):
                raise TypeError("generated model 'result' must be a build123d Shape")
            if output_path is not None:
                output_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = output_path.with_name(
                    f".{output_path.name}.{os.getpid()}.tmp"
                )
                try:
                    bd.export_step(result, str(temporary))
                    os.replace(temporary, output_path)
                finally:
                    temporary.unlink(missing_ok=True)
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
            "sourceFiles": sorted(set(_source_files(source, source_roots, before_modules)) | {str(path) for path in accessed_files if path != output_path and ".pi-cad" not in path.parts}),
        }
    except Exception as exc:  # pragma: no cover - formatted below
        return {
            "exitCode": 1,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue() + "\n" + traceback.format_exc(),
            "error": str(exc),
            "sourceFiles": sorted(set(_source_files(source, source_roots, before_modules)) | {str(path) for path in accessed_files if path != output_path and ".pi-cad" not in path.parts}),
        }
    finally:
        audit_state["active"] = False
        if cwd != old_cwd:
            os.chdir(old_cwd)
        for entry in inserted_paths:
            if entry in sys.path:
                sys.path.remove(entry)
