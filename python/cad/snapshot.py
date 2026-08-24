from __future__ import annotations

import dataclasses
import hashlib
import json
from pathlib import Path
from typing import Any, Callable


class SnapshotError(TypeError):
    pass


Encoder = Callable[[Any], Any]
Decoder = Callable[[Any], Any]


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)


class SnapshotRegistry:
    def __init__(self) -> None:
        self._encoders: list[tuple[type[Any], str, Encoder]] = []
        self._decoders: dict[str, Decoder] = {}

    def register(self, python_type: type[Any], name: str, encoder: Encoder, decoder: Decoder) -> None:
        if not name or name in self._decoders:
            raise ValueError(f"duplicate or invalid snapshot codec: {name}")
        self._encoders.append((python_type, name, encoder))
        self._decoders[name] = decoder

    def encode(self, value: Any) -> dict[str, Any]:
        codec, payload, metadata = self._encode_value(value)
        body = {"codec": codec, "value": payload}
        if metadata is not None:
            body["metadata"] = metadata
        body["sha256"] = hashlib.sha256(_canonical(body).encode()).hexdigest()
        return body

    def decode(self, snapshot: dict[str, Any]) -> Any:
        codec = snapshot.get("codec")
        value = snapshot.get("value")
        if codec in self._decoders:
            return self._decoders[codec](value)
        if codec == "json":
            return value
        if codec == "path":
            return Path(value["path"])
        if codec == "dataclass":
            return value["fields"]
        if codec == "numpy.ndarray":
            try:
                import numpy as np
            except ImportError as error:
                raise SnapshotError("NumPy is required to load this snapshot") from error
            return np.asarray(value["data"], dtype=value["dtype"]).reshape(value["shape"])
        if codec == "table":
            try:
                import pandas as pd
            except ImportError:
                return value
            return pd.DataFrame(data=value["data"], columns=value["columns"], index=value["index"])
        if codec == "cad.snapshot":
            return value
        raise SnapshotError(f"unsupported snapshot codec: {codec}")

    def _encode_value(self, value: Any) -> tuple[str, Any, Any | None]:
        for python_type, name, encoder in reversed(self._encoders):
            if isinstance(value, python_type):
                return name, _json_value(encoder(value)), None
        if _is_json(value):
            return "json", _json_value(value), None
        if isinstance(value, Path):
            payload: dict[str, Any] = {"path": value.as_posix(), "exists": value.exists()}
            if value.is_file():
                payload["contentSha256"] = hashlib.sha256(value.read_bytes()).hexdigest()
            elif value.exists():
                raise SnapshotError("directory Path snapshots are not supported implicitly")
            return "path", payload, None
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            return "dataclass", {
                "type": f"{type(value).__module__}.{type(value).__qualname__}",
                "fields": _json_value(dataclasses.asdict(value)),
            }, None
        if type(value).__module__.startswith("numpy") and hasattr(value, "tolist") and hasattr(value, "dtype") and hasattr(value, "shape"):
            return "numpy.ndarray", {"dtype": str(value.dtype), "shape": list(value.shape), "data": _json_value(value.tolist())}, None
        if hasattr(value, "to_dict") and hasattr(value, "columns") and hasattr(value, "index"):
            split = value.to_dict(orient="split")
            return "table", _json_value(split), None
        snapshot = getattr(value, "__cad_snapshot__", None)
        if callable(snapshot):
            return "cad.snapshot", _json_value(snapshot()), {"type": f"{type(value).__module__}.{type(value).__qualname__}"}
        raise SnapshotError(f"unsupported object {type(value).__module__}.{type(value).__qualname__}; register a codec or implement __cad_snapshot__; pickle is never used")


def _is_json(value: Any) -> bool:
    if value is None or isinstance(value, (bool, int, float, str)):
        return True
    if isinstance(value, (list, tuple)):
        return all(_is_json(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json(item) for key, item in value.items())
    return False


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise SnapshotError("snapshot contains a non-finite float")
        return value
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise SnapshotError("snapshot dict keys must be strings")
        return {key: _json_value(item) for key, item in value.items()}
    raise SnapshotError(f"snapshot payload is not JSON-safe: {type(value).__name__}")


registry = SnapshotRegistry()


def register(python_type: type[Any], name: str, encoder: Encoder, decoder: Decoder) -> None:
    registry.register(python_type, name, encoder, decoder)
