"""Run arbitrary CAD analysis on a disposable copy of the subject STEP.

The imported shape and working directory belong to the temporary experiment.
The original artifact is never passed into agent code. This isolates normal
engineering exploration; it is not a security sandbox for hostile code.
"""
from __future__ import annotations

import builtins
import contextlib
import io
import json
import math
import os
import signal
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


class ProbeSelection:
    """Resolved engineering identity plus its exact B-Rep objects."""

    def __init__(self, identity: dict[str, Any], objects: list[Any]) -> None:
        self.identity = identity
        self.objects = tuple(objects)

    @property
    def object(self) -> Any:
        if len(self.objects) != 1:
            raise ProbeError(f"selection has {len(self.objects)} objects; use .objects explicitly")
        return self.objects[0]

class ProbeError(Exception):
    """Raised for probe misuse or execution failure."""


def run_probe(artifact: Path, code: str, timeout_s: int = 25, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """Execute ``code`` against ``artifact`` and return the probe result dict.

    The scope preloads ``shape`` (the imported STEP), ``bd`` (build123d),
    ``math``, ``statistics``, and ``np`` (numpy). The script must leave a
    JSON-serializable object in ``result``.
    """
    started = time.monotonic()
    import build123d as bd
    import numpy as np
    from .interference import InterferenceUnresolvedError, inspect_interference_batch, inspect_interference_shape
    from .identity import IdentityIndex
    from .identity.manifest import identity_path
    from .common import sha256_file
    from .geometry import measure_shape

    def _alarm(_signum: int, _frame: Any) -> None:
        raise TimeoutError(f"probe exceeded {timeout_s}s CPU wall limit")

    with tempfile.TemporaryDirectory(prefix="cad-probe-") as scratch:
        subject = Path(scratch) / "subject.step"
        try:
            shutil.copyfile(artifact, subject)
            source_identity = identity_path(artifact)
            if source_identity.is_file():
                shutil.copyfile(source_identity, identity_path(subject))
            shape = bd.import_step(str(subject))
        except Exception as error:  # noqa: BLE001 - surfaced as probe failure
            raise ProbeError(f"cannot import subject artifact: {error}") from error
        execution_started = time.monotonic()
        identity_index = IdentityIndex(subject)

        def resolve_identity(
            target: str,
            *,
            kind: str | None = None,
            owner: str | None = None,
            expect: Any = None,
        ) -> ProbeSelection:
            resolution, objects = identity_index.resolve_shapes(
                target, shape, kind=kind, owner=owner, expect=expect
            )
            manifest_file = identity_path(subject)
            payload = resolution.as_payload()
            payload["manifestVersion"] = (identity_index.manifest or {}).get("version")
            payload["manifestHash"] = sha256_file(manifest_file) if manifest_file.is_file() else None
            return ProbeSelection(payload, objects)

        def measure_subject(metric: str, a: str, b: str | None = None) -> dict[str, Any]:
            return measure_shape(shape, metric, a, b, identity_index=identity_index)

        def resolve_interference_pairs(target_pairs: list[tuple[str, str]]) -> tuple[list[tuple[int, int]], list[dict[str, Any]]]:
            solid_pairs: set[tuple[int, int]] = set()
            subjects: list[dict[str, Any]] = []
            for left, right in target_pairs:
                left_resolution, _ = identity_index.resolve_shapes(left, shape, expect="many")
                right_resolution, _ = identity_index.resolve_shapes(right, shape, expect="many")
                subjects.extend((left_resolution.as_payload(), right_resolution.as_payload()))
                left_solids = left_resolution.solid_indices
                right_solids = right_resolution.solid_indices
                if not left_solids or not right_solids:
                    raise ProbeError(f"interference groups {left!r} and {right!r} must bind solid geometry")
                for a in left_solids:
                    for b in right_solids:
                        if a == b:
                            raise ProbeError(f"interference groups {left!r} and {right!r} share solid {a}")
                        solid_pairs.add(tuple(sorted((a, b))))
            if not solid_pairs:
                raise ProbeError("interference selection resolved to no solid pairs")
            return sorted(solid_pairs), subjects

        def interference_named(target_pairs: list[tuple[str, str]]) -> dict[str, Any]:
            solid_pairs, subjects = resolve_interference_pairs(target_pairs)
            return {**inspect_interference_shape(shape, solid_pairs), "resolvedSubjects": subjects}

        def interference_batch_named(
            target_pairs: list[tuple[str, str]], poses: list[dict[str, Any]]
        ) -> dict[str, Any]:
            solid_pairs, subjects = resolve_interference_pairs(target_pairs)
            return {**inspect_interference_batch(shape, poses, solid_pairs), "resolvedSubjects": subjects}

        scope: dict[str, Any] = {
            "__builtins__": builtins.__dict__,
            "shape": shape,
            "artifact_path": str(subject),
            "scratch_dir": scratch,
            "bd": bd,
            "math": math,
            "statistics": statistics,
            "np": np,
            "cad_interference": inspect_interference_shape,
            "cad_interference_batch": inspect_interference_batch,
            "cad_interference_named": interference_named,
            "cad_interference_batch_named": interference_batch_named,
            "InterferenceUnresolvedError": InterferenceUnresolvedError,
            "params": params or {},
            "identity_index": identity_index,
            "cad_resolve": resolve_identity,
            "cad_measure": measure_subject,
            "result": None,
        }
        previous_cwd = os.getcwd()
        previous_argv = sys.argv
        previous_handler = signal.signal(signal.SIGALRM, _alarm)
        printed = io.StringIO()
        with tempfile.TemporaryFile(mode="w+b") as process_stdout:
            saved_stdout_fd = os.dup(1)
            try:
                os.chdir(scratch)
                sys.argv = ["<cad-probe>", str(subject)]
                os.dup2(process_stdout.fileno(), 1)
                signal.alarm(timeout_s)
                with contextlib.redirect_stdout(printed):
                    exec(compile(code, "<cad-probe>", "exec"), scope)  # noqa: S102 - intentional arbitrary analysis
                result = scope.get("result")
                if result is None:
                    raise ProbeError("probe code did not set 'result'; assign a JSON-serializable dict to result")
                try:
                    json.dumps(result)
                except (TypeError, ValueError) as error:
                    raise ProbeError(f"probe result is not JSON-serializable: {error}") from error
            except TimeoutError as error:
                raise ProbeError(str(error)) from error
            except ProbeError:
                raise
            except BaseException as error:  # noqa: BLE001 - agent code, any failure is a probe error
                raise ProbeError(f"{type(error).__name__}: {error}") from error
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, previous_handler)
                sys.argv = previous_argv
                os.chdir(previous_cwd)
                os.dup2(saved_stdout_fd, 1)
                os.close(saved_stdout_fd)
            process_stdout.seek(0, os.SEEK_END)
            process_stdout.seek(max(0, process_stdout.tell() - 8192))
            external_output = process_stdout.read().decode("utf-8", errors="replace")

    return {
        "result": result,
        "stdout": (printed.getvalue() + external_output)[-8192:],
        "importSeconds": round(execution_started - started, 3),
        "executionSeconds": round(time.monotonic() - execution_started, 3),
        "probeSeconds": round(time.monotonic() - started, 3),
    }
