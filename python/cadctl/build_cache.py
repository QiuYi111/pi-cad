"""Local build identity, cache metadata, and per-output serialization."""

from __future__ import annotations

import ast
import contextlib
import hashlib
import importlib.metadata
import json
import os
import platform
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import __version__
from .common import sha256_file

SCHEMA_VERSION = 1


def semantic_file_hash(path: str | Path) -> str:
    """Hash Python syntax rather than comments and formatting when possible."""
    source = Path(path)
    if source.suffix.lower() != ".py":
        return "bytes:" + sha256_file(source)
    try:
        tree = ast.parse(source.read_bytes(), filename=str(source))
    except (OSError, SyntaxError, ValueError, MemoryError, RecursionError):
        return "bytes:" + sha256_file(source)
    dumped = ast.dump(tree, include_attributes=False)
    return "ast1:" + hashlib.sha256(dumped.encode("utf-8")).hexdigest()


def canonical_parameters_hash(parameters: dict[str, Any] | None) -> str:
    encoded = json.dumps(
        parameters or {},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _runtime_identity() -> dict[str, str]:
    try:
        build123d_version = importlib.metadata.version("build123d")
    except importlib.metadata.PackageNotFoundError:
        build123d_version = "unknown"
    return {
        "cadctl": __version__,
        "python": platform.python_version(),
        "build123d": build123d_version,
    }


def _cache_root(cwd: str | Path) -> Path:
    root = Path(cwd).resolve() / ".pi-cad" / "cache" / "build"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _output_key(output: str | Path) -> str:
    value = str(Path(output).resolve()).encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def manifest_path(cwd: str | Path, output: str | Path) -> Path:
    return _cache_root(cwd) / f"{_output_key(output)}.json"


def lock_path(cwd: str | Path, output: str | Path) -> Path:
    return _cache_root(cwd) / f"{_output_key(output)}.lock"


@contextmanager
def exclusive_build(cwd: str | Path, output: str | Path) -> Iterator[None]:
    """Serialize writers. Kernel locks disappear automatically after a crash."""
    path = lock_path(cwd, output)
    handle = path.open("a+b")
    try:
        if os.name == "posix":
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        elif os.name == "nt":  # pragma: no cover - native Windows is not shipped
            import msvcrt

            if path.stat().st_size == 0:
                handle.write(b" ")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:  # pragma: no cover
            raise RuntimeError("Pi-CAD build locking is unavailable on this platform")
        yield
    finally:
        with contextlib.suppress(OSError):
            if os.name == "posix":
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            elif os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        handle.close()


def _dependency_entries(files: list[str], root: str | Path) -> list[dict[str, str]]:
    root_path = Path(root).resolve()
    unique = sorted({str(Path(item).resolve()) for item in files})
    entries: list[dict[str, str]] = []
    for item in unique:
        path = Path(item)
        try:
            identity = path.relative_to(root_path).as_posix()
        except ValueError:
            identity = str(path)
        entries.append({"path": item, "identity": identity, "hash": semantic_file_hash(item)})
    return entries


def _closure_hash(entries: list[dict[str, str]]) -> str:
    digest = hashlib.sha256()
    for entry in sorted(entries, key=lambda item: item["path"]):
        digest.update(entry.get("identity", entry["path"]).encode("utf-8"))
        digest.update(b"\0")
        digest.update(entry["hash"].encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def make_manifest(
    *,
    source_files: list[str],
    root: str | Path,
    output: str | Path,
    parameters_hash: str,
) -> dict[str, Any]:
    dependencies = _dependency_entries(source_files, root)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "runtime": _runtime_identity(),
        "parametersHash": parameters_hash,
        "sourceClosureHash": _closure_hash(dependencies),
        "dependencies": dependencies,
        "output": str(Path(output).resolve()),
        "outputHash": sha256_file(output),
    }


def current_manifest(
    cwd: str | Path,
    output: str | Path,
    *,
    parameters_hash: str,
) -> dict[str, Any] | None:
    path = manifest_path(cwd, output)
    target = Path(output).resolve()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("schemaVersion") != SCHEMA_VERSION:
            return None
        if value.get("runtime") != _runtime_identity():
            return None
        if value.get("parametersHash") != parameters_hash:
            return None
        if value.get("output") != str(target) or not target.is_file():
            return None
        if value.get("outputHash") != sha256_file(target):
            return None
        dependencies = value.get("dependencies")
        if not isinstance(dependencies, list) or not dependencies:
            return None
        current: list[dict[str, str]] = []
        for entry in dependencies:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                return None
            dependency = Path(entry["path"])
            if not dependency.is_file():
                return None
            current.append(
                {
                    "path": str(dependency.resolve()),
                    "identity": str(entry.get("identity") or dependency.resolve()),
                    "hash": semantic_file_hash(dependency),
                }
            )
        closure_hash = _closure_hash(current)
        if closure_hash != value.get("sourceClosureHash"):
            return None
        return value
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def write_manifest(cwd: str | Path, output: str | Path, value: dict[str, Any]) -> Path:
    destination = manifest_path(cwd, output)
    fd, raw = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    temp = Path(raw)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)
    return destination
