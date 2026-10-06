"""One open FreeCAD document: ops, transactions, history, export (imports FreeCAD)."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

import FreeCAD as App
import Part

from . import export as export_module
from . import intent as intent_module
from . import summary
from .core import (
    PARAMS_NAME, REQUIREMENTS_NAME, bodies, body_features, get_path, is_body, is_feature, is_sketch,
    path_index, set_path,
)
from .errors import ReifyOpError, failure_code, hints_for
from .exprs import PARAMS_OBJECT
from .naming import canonicalize_path
from .ops import handler_for, validate_ops
from .ops.context import OpContext
from .roles import BodyRoles, compute_body_roles, label_anchor
from .queries import DEFAULT_DENSITY_G_CM3

HISTORY_LIMIT = 20
_SETTABLE_DISPLAY = ("Length", "Length2", "Depth", "Diameter", "Radius", "Size", "Occurrences", "Angle", "Reversed", "Midplane", "Type")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _value(raw: Any) -> Any:
    if hasattr(raw, "Value"):
        return round(float(raw.Value), 6)
    if isinstance(raw, float):
        return round(raw, 6)
    return raw if isinstance(raw, (int, str, bool)) else str(raw)


class _RecomputeRecorder:
    """Document observer: a feature whose ``Shape`` is assigned during recompute was recomputed."""

    def __init__(self) -> None:
        self.names: set[str] = set()
        self.document_name: str | None = None

    def slotChangedObject(self, obj: Any, prop: str) -> None:  # noqa: N802 (FreeCAD callback name)
        if prop == "Shape" and obj.Document.Name == self.document_name:
            self.names.add(obj.Name)


class DocumentSession:
    def __init__(self, fcstd: Path, output: Path, history_dir: Path, body_path: str | None) -> None:
        self.fcstd = fcstd
        self.output = output
        self.history_dir = history_dir
        self.log_path = fcstd.with_name(fcstd.name + ".ops.jsonl")
        self.body_path = body_path
        self.doc: Any = None
        self.rev = 0
        self._generation = 0
        self._roles: dict[str, tuple[int, BodyRoles]] = {}
        self._recomputed: set[str] = set()
        self._recorder = _RecomputeRecorder()
        App.addDocumentObserver(self._recorder)

    # ------------------------------------------------------------ lifecycle
    def open(self, create: bool) -> bool:
        """Open the document; returns True when it was created."""
        created = False
        if self.fcstd.exists():
            self._load()
        elif create:
            self.fcstd.parent.mkdir(parents=True, exist_ok=True)
            self.doc = App.newDocument(self._doc_name())
            self.doc.UndoMode = 1
            self._ensure_scaffold()
            self.doc.recompute()
            self.doc.saveAs(str(self.fcstd))
            created = True
        else:
            raise ReifyOpError("TARGET_NOT_FOUND", f"document {self.fcstd.name} does not exist", target=str(self.fcstd),
                               detail={"target": str(self.fcstd), "known": []}, hints=["open with create=True"])
        self.rev = self._count_log()
        return created

    def _doc_name(self) -> str:
        return "".join(ch if ch.isalnum() else "_" for ch in self.fcstd.stem) or "Part"

    def _load(self) -> None:
        if self.doc is not None:
            try:
                App.closeDocument(self.doc.Name)
            except Exception:
                pass
        self.doc = App.openDocument(str(self.fcstd))
        self.doc.UndoMode = 1
        self._ensure_scaffold()
        self.doc.recompute()
        self._invalidate()

    def reload(self) -> None:
        """Throw away in-memory changes: reopen the last saved state."""
        self._load()

    def close(self) -> None:
        try:
            App.removeDocumentObserver(self._recorder)
        except Exception:
            pass
        if self.doc is not None:
            try:
                App.closeDocument(self.doc.Name)
            except Exception:
                pass
            self.doc = None

    def _ensure_scaffold(self) -> None:
        doc = self.doc
        index = path_index(doc)
        if PARAMS_OBJECT not in index:
            vs = doc.addObject("App::VarSet", PARAMS_NAME)
            set_path(vs, PARAMS_OBJECT)
        existing = [b for b in bodies(doc)]
        if not existing:
            body = doc.addObject("PartDesign::Body", "Body")
            set_path(body, canonicalize_path(self.body_path or self.fcstd.stem))
        doc.recompute()

    # ------------------------------------------------------------ accessors
    def params_object(self) -> Any:
        return self.doc.getObject(PARAMS_NAME)

    def param_names(self) -> set[str]:
        vs = self.params_object()
        return {p for p in vs.PropertiesList if vs.getGroupOfProperty(p) == "Params"}

    def param_values(self) -> dict[str, Any]:
        vs = self.params_object()
        return {name: _value(getattr(vs, name)) for name in sorted(self.param_names())}

    def density(self) -> float:
        vs = self.params_object()
        return float(getattr(vs, "density")) if "density" in self.param_names() else DEFAULT_DENSITY_G_CM3

    def default_body(self) -> Any:
        found = bodies(self.doc)
        if self.body_path:
            for body in found:
                if get_path(body) == self.body_path:
                    return body
        return found[0]

    def requirements_group(self, create: bool) -> Any | None:
        group = self.doc.getObject(REQUIREMENTS_NAME)
        if group is None and create:
            group = self.doc.addObject("App::DocumentObjectGroup", REQUIREMENTS_NAME)
        return group

    # ------------------------------------------------------------ recompute and roles
    def _invalidate(self) -> None:
        self._generation += 1

    def recompute(self) -> None:
        self._recorder.document_name = self.doc.Name
        self._recorder.names.clear()
        self.doc.recompute()
        for name in self._recorder.names:
            obj = self.doc.getObject(name)
            path = get_path(obj) if obj is not None else None
            if path and (is_feature(obj) or is_sketch(obj)):
                self._recomputed.add(path)
        self._invalidate()

    def roles(self, body: Any) -> BodyRoles:
        cached = self._roles.get(body.Name)
        if cached and cached[0] == self._generation:
            return cached[1]
        roles = compute_body_roles(body)
        self._roles[body.Name] = (self._generation, roles)
        return roles

    # ------------------------------------------------------------ snapshots
    def snapshot(self) -> dict[str, Any]:
        paths: dict[str, str] = {}
        props: dict[str, Any] = {}
        for obj in self.doc.Objects:
            path = get_path(obj)
            if not path or path == PARAMS_OBJECT:
                continue
            paths[path] = obj.TypeId
            if is_feature(obj) or is_sketch(obj):
                values = {name: _value(getattr(obj, name)) for name in _SETTABLE_DISPLAY if name in obj.PropertiesList}
                if is_sketch(obj):
                    values.update({f"constraint:{c.Name}": _value(c.Value) for c in obj.Constraints if c.Name})
                props[path] = values
        signatures: dict[str, Any] = {}
        for body in bodies(self.doc):
            if body.Shape.isNull():
                continue
            for key, entries in self.roles(body).faces.items():
                signatures[key] = sorted(
                    (type(f.face.Surface).__name__, *[round(c, 3) for c in self.roles(body).point_to_world(f.face.CenterOfMass)], round(f.face.Area, 3))
                    for f in entries
                )
        return {"paths": paths, "props": props, "params": self.param_values(), "roles": signatures}

    # ------------------------------------------------------------ health checks
    def check_health(self, op_index: int | None) -> list[dict[str, Any]]:
        warnings: list[dict[str, Any]] = []
        for obj in self.doc.Objects:
            state = list(obj.State)
            if "Invalid" in state or "Error" in state or not obj.isValid():
                status = obj.getStatusString() if hasattr(obj, "getStatusString") else ";".join(state)
                path = get_path(obj) or obj.Label
                if is_sketch(obj):
                    from .ops.sketch import check_sketch  # conflicts are reported with the sketch name

                    ctx = OpContext(self)
                    check_sketch(ctx, obj)
                code = failure_code(obj.TypeId, status)
                raise ReifyOpError(
                    code, f"{path} failed to recompute: {status}", target=path,
                    detail={"feature": path, "freecadStatus": status}, hints=hints_for(code),
                )
        ctx = OpContext(self)
        from .ops.sketch import check_sketch

        for obj in self.doc.Objects:
            if is_sketch(obj):
                warnings.extend(check_sketch(ctx, obj))
        return warnings

    def check_bodies(self) -> None:
        for body in bodies(self.doc):
            if not body_features(body):
                continue
            shape = body.Shape
            path = get_path(body) or body.Label
            if shape.isNull() or not shape.Solids:
                raise ReifyOpError("RESULT_NOT_SOLID", f"body {path} has no solid", target=path,
                                   detail={"body": path, "solids": 0, "validity": "empty"})
            if len(shape.Solids) != 1:
                raise ReifyOpError("RESULT_MULTIPLE_SOLIDS", f"body {path} has {len(shape.Solids)} separate solids", target=path,
                                   detail={"body": path, "solids": len(shape.Solids), "validity": "multiple"},
                                   hints=["make the sketches overlap so the solids fuse"])
            if not shape.isValid():
                raise ReifyOpError("RESULT_NOT_SOLID", f"body {path} is not a valid solid", target=path,
                                   detail={"body": path, "solids": 1, "validity": "invalid"})

    # ------------------------------------------------------------ apply / try
    def apply(self, ops: list[Any], *, commit: bool, message: str | None, output: Path | None = None) -> dict[str, Any]:
        started = time.monotonic()
        normalised = validate_ops(ops)
        before = self.snapshot()
        self._recomputed = set()
        ctx = OpContext(self)
        warnings: list[dict[str, Any]] = []
        self.doc.openTransaction("reify-apply")
        index = -1
        try:
            for index, op in enumerate(normalised):
                handler_for(op["op"])(ctx, op)
                self.recompute()
                warnings.extend(self.check_health(index))
            index = -1
            self.check_bodies()
        except ReifyOpError as error:
            self._abort()
            error.rolled_back = True
            if index >= 0:
                error.failed_op_index = index
            raise
        except Exception as error:
            self._abort()
            code = "FEATURE_FAILED"
            wrapped = ReifyOpError(code, f"{type(error).__name__}: {error}", detail={"feature": normalised[index]["op"] if index >= 0 else "?", "freecadStatus": str(error)})
            wrapped.rolled_back = True
            wrapped.failed_op_index = index if index >= 0 else None
            raise wrapped from error

        result: dict[str, Any] = {}
        try:
            after = self.snapshot()
            result = self._result(before, after, warnings)
            step = output or self.output
            result.update(self._export(step))
        except ReifyOpError:
            self._abort()
            raise
        if commit:
            self.doc.commitTransaction()
            self._commit(normalised, message)
            result["rev"] = self.rev
            result["fcstd"] = str(self.fcstd)
            result["fcstdSha256"] = _sha256(self.fcstd)
        else:
            self._abort()
            result["rev"] = self.rev
        result["elapsedMs"] = int((time.monotonic() - started) * 1000)
        return result

    def _abort(self) -> None:
        try:
            self.doc.abortTransaction()
        except Exception:
            pass
        self.reload()  # the saved file is the only trusted state

    def _result(self, before: dict[str, Any], after: dict[str, Any], warnings: list[dict[str, Any]]) -> dict[str, Any]:
        ctx = OpContext(self)
        intents = intent_module.evaluate_all(ctx)
        paths_before, paths_after = set(before["paths"]), set(after["paths"])
        features = summary.diff_features(paths_before, paths_after, self._recomputed)
        params = summary.diff_params(before["params"], after["params"])
        changed_roles = summary.changed_role_paths(before["roles"], after["roles"])
        changed_props = [p for p in after["props"] if p in before["props"] and after["props"][p] != before["props"][p]]
        highlight = sorted(set(changed_roles) | {p for p in changed_props if not any(r.startswith(p + "/") for r in changed_roles)})
        highlight = [p for p in highlight if p in paths_after or p in after["roles"]]
        deduped: dict[str, None] = {}
        for item in warnings:
            deduped[json.dumps(item, sort_keys=True)] = None
        return {
            "features": features,
            "params": params,
            "intent": intents,
            "warnings": [json.loads(item) for item in deduped],
            "highlight": {"paths": highlight},
            "annotations": self._annotations(highlight, changed_roles),
        }

    def _annotations(self, highlight: list[str], changed_roles: list[str]) -> list[dict[str, Any]]:
        """Labels anchored on a visible face of each highlighted feature (first build: every feature)."""
        biggest: dict[str, tuple[float, Any]] = {}
        for body in bodies(self.doc):
            if body.Shape.isNull():
                continue
            roles = self.roles(body)
            for key, entries in roles.faces.items():
                feature = summary.feature_of_role(key)
                if changed_roles and key not in highlight and feature not in highlight:
                    continue
                for entry in entries:
                    point, weight = label_anchor(entry.face)
                    score = entry.face.Area * weight
                    if feature not in biggest or score > biggest[feature][0]:
                        biggest[feature] = (score, roles.point_to_world(point))
        labels = []
        for feature, (_area, point) in sorted(biggest.items()):
            labels.append({"text": feature.split("/")[-1], "at": [round(point.x, 4), round(point.y, 4), round(point.z, 4)]})
        return labels[: summary.MAX_ANNOTATIONS]

    def _export(self, step: Path) -> dict[str, Any]:
        if not export_module.solid_bodies(self):
            return {"step": None, "declarations": None, "empty": True}
        export_module.write_step(self, step)
        declarations = export_module.write_declarations(self, step)
        return {"step": str(step), "declarations": str(declarations)}

    # ------------------------------------------------------------ history
    def _count_log(self) -> int:
        if not self.log_path.exists():
            return 0
        return sum(1 for line in self.log_path.read_text(encoding="utf-8").splitlines() if line.strip())

    def _history_file(self, rev: int) -> Path:
        return self.history_dir / f"{rev}.FCStd"

    def _commit(self, ops: list[dict[str, Any]], message: str | None) -> None:
        self.history_dir.mkdir(parents=True, exist_ok=True)
        if self.fcstd.exists():
            shutil.copy2(self.fcstd, self._history_file(self.rev))
        temporary = self.fcstd.with_name(f".{self.fcstd.stem}.{os.getpid()}.tmp.FCStd")
        self.doc.saveCopy(str(temporary))
        os.replace(temporary, self.fcstd)
        self.rev += 1
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"rev": self.rev, "ops": ops, "message": message, "fcstdSha256": _sha256(self.fcstd)}, ensure_ascii=False) + "\n")
        self._prune_history()

    def _prune_history(self) -> None:
        saved = sorted(self.history_dir.glob("*.FCStd"), key=lambda p: int(p.stem) if p.stem.isdigit() else -1)
        for old in saved[:-HISTORY_LIMIT]:
            old.unlink(missing_ok=True)

    def undo(self) -> dict[str, Any]:
        if self.rev <= 0:
            raise ReifyOpError("NOTHING_TO_UNDO", "the document is at its first revision", hints=["nothing to undo"])
        previous = self._history_file(self.rev - 1)
        if not previous.exists():
            raise ReifyOpError("NOTHING_TO_UNDO", f"revision {self.rev - 1} is older than the {HISTORY_LIMIT} kept copies",
                               detail={"rev": self.rev, "kept": HISTORY_LIMIT})
        started = time.monotonic()
        shutil.copy2(previous, self.fcstd)
        lines = self.log_path.read_text(encoding="utf-8").splitlines()
        self.log_path.write_text("".join(line + "\n" for line in lines[:-1]), encoding="utf-8")
        previous.unlink(missing_ok=True)
        self.rev -= 1
        self.reload()
        result = {"features": {"recomputed": [], "added": [], "removed": []}, "params": {"changed": {}}, "intent": intent_module.evaluate_all(OpContext(self)),
                  "warnings": [], "highlight": {"paths": []}, "annotations": self._annotations([], []), "rev": self.rev,
                  "fcstd": str(self.fcstd), "fcstdSha256": _sha256(self.fcstd), "undone": True}
        result.update(self._export(self.output))
        result["elapsedMs"] = int((time.monotonic() - started) * 1000)
        return result

    # ------------------------------------------------------------ read-only views
    def export_current(self, output: Path | None = None) -> dict[str, Any]:
        result = {
            "features": {"recomputed": [], "added": [], "removed": []}, "params": {"changed": {}},
            "intent": intent_module.evaluate_all(OpContext(self)), "warnings": [], "highlight": {"paths": []},
            "annotations": self._annotations([], []), "rev": self.rev, "fcstd": str(self.fcstd), "fcstdSha256": _sha256(self.fcstd),
        }
        result.update(self._export(output or self.output))
        return result

    def tree(self) -> dict[str, Any]:
        features = []
        for body in bodies(self.doc):
            roles = self.roles(body) if not body.Shape.isNull() else None
            body_path = get_path(body)
            entries = []
            for obj in body.Group:
                path = get_path(obj)
                if not path:
                    continue
                entry: dict[str, Any] = {"path": path, "type": obj.TypeId.split("::")[-1]}
                params = {n: _value(getattr(obj, n)) for n in _SETTABLE_DISPLAY if n in obj.PropertiesList}
                if params:
                    entry["params"] = params
                profile = getattr(obj, "Profile", None) if "Profile" in obj.PropertiesList else None
                sketch = profile[0] if isinstance(profile, tuple) else profile
                if sketch is not None and get_path(sketch):
                    entry["sketch"] = get_path(sketch)
                if is_sketch(obj):
                    entry["constraints"] = {c.Name: _value(c.Value) for c in obj.Constraints if c.Name}
                    entry["dof"] = int(getattr(obj, "DoF", 0) or 0)
                expressions = [f"{prop} = {expr}" for prop, expr in getattr(obj, "ExpressionEngine", [])]
                if expressions:
                    entry["expressions"] = expressions
                if roles is not None and is_feature(obj):
                    entry["roles"] = sorted(k[len(path) + 1:] for k in roles.faces if k.startswith(path + "/"))
                entries.append(entry)
            placement = body.Placement
            features.append({
                "body": body_path,
                "placement": {"position": [round(v, 4) for v in placement.Base], "angleDeg": round(placement.Rotation.Angle * 57.29577951308232, 4)},
                "objects": entries,
            })
        requirements = intent_module.evaluate_all(OpContext(self))
        return {"rev": self.rev, "params": self.param_values(), "bodies": features, "requirements": requirements}
