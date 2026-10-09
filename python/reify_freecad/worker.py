"""NDJSON worker: one request per line on stdin, one response per line on stdout.

stdout carries protocol lines only; FreeCAD console output is sent to stderr.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

# Keep the protocol channel clean before FreeCAD can print to it.
_PROTOCOL = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr


def _arm_owner_death_signal() -> None:
    """Exit with the parent (Linux): the kernel signals us when it dies."""
    try:
        import ctypes

        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(1, int(signal.SIGKILL), 0, 0, 0)  # PR_SET_PDEATHSIG
        if os.getppid() == 1:
            os._exit(0)
    except Exception:
        pass


def _watch_parent() -> None:
    parent = os.getppid()

    def loop() -> None:
        while True:
            time.sleep(2.0)
            if os.getppid() != parent:
                os._exit(0)

    threading.Thread(target=loop, daemon=True).start()


_arm_owner_death_signal()
_watch_parent()

from .errors import ReifyOpError  # noqa: E402


def _error_wire(error: ReifyOpError) -> dict[str, Any]:
    return error.to_wire()


class Worker:
    def __init__(self) -> None:
        from .registry import SessionRegistry

        self.sessions: dict[str, Any] = {}
        self.registry = SessionRegistry(self.sessions)

    # ------------------------------------------------------------ helpers
    def _session(self, doc: str) -> Any:
        session = self.sessions.get(doc)
        if session is None:
            raise ReifyOpError("DOCUMENT_NOT_OPEN", f"{doc} is not open", target=doc, hints=["call open first"])
        return session

    def _ctx(self, session: Any) -> Any:
        from .ops.context import OpContext

        session.sync_links()  # reads see the latest revision of every linked part
        return OpContext(session)

    # ------------------------------------------------------------ commands
    def cmd_open(self, doc: str, args: dict[str, Any]) -> dict[str, Any]:
        from .session import DocumentSession

        existing = self.sessions.get(doc)
        if existing is not None:
            existing.close()
        self.registry.adopt(Path(doc))  # one session owns a document, even when an assembly linked it first
        session = DocumentSession(Path(doc), Path(args["output"]), Path(args["historyDir"]), args.get("body"))
        session.registry = self.registry
        session.root = Path(args["root"]) if args.get("root") else Path(doc).parent
        created = session.open(bool(args.get("create", False)))
        self.sessions[doc] = session
        result: dict[str, Any] = {
            "created": created, "rev": session.rev, "fcstd": doc,
            "bodies": [b.Label for b in session.doc.Objects if b.TypeId == "PartDesign::Body"],
            "paramValues": session.param_values(),
        }
        if args.get("export", True):  # a silent reopen after a restart exports nothing
            result.update(session.export_current())
        return result

    def cmd_apply(self, doc: str, args: dict[str, Any]) -> dict[str, Any]:
        session = self._session(doc)
        return session.apply(args["ops"], commit=True, message=args.get("message"), observe=bool(args.get("observe", True)))

    def cmd_try(self, doc: str, args: dict[str, Any]) -> dict[str, Any]:
        session = self._session(doc)
        return session.apply(args["ops"], commit=False, message=None, output=Path(args["output"]))

    def cmd_undo(self, doc: str, args: dict[str, Any]) -> dict[str, Any]:
        return self._session(doc).undo(to_empty=bool(args.get("to_empty", False)))

    def cmd_tree(self, doc: str, args: dict[str, Any]) -> dict[str, Any]:
        session = self._session(doc)
        session.sync_links()
        return session.tree()

    def cmd_export_features(self, doc: str, args: dict[str, Any]) -> dict[str, Any]:
        """Canonical feature JSON of the recomputed document (read only: no revision, no history)."""
        from . import transfer

        session = self._session(doc)
        session.sync_links()
        return transfer.export_features(session, args.get("output"), args.get("referenceStep"))

    def cmd_export_assembly(self, doc: str, args: dict[str, Any]) -> dict[str, Any]:
        """``reify.assembly/1`` of an assembly document (read only)."""
        from . import transfer

        session = self._session(doc)
        return transfer.export_assembly(session, args.get("output"), args.get("referenceStep"))

    def cmd_query(self, doc: str, args: dict[str, Any]) -> dict[str, Any]:
        from . import queries

        session = self._session(doc)
        return queries.query(self._ctx(session), args["target"], args.get("what"))

    def cmd_check(self, doc: str, args: dict[str, Any], budget_s: float) -> dict[str, Any]:
        from . import queries

        session = self._session(doc)
        return queries.run_check(self._ctx(session), args["kind"], args.get("args") or {}, queries.Budget(budget_s))

    def cmd_dfm(self, doc: str, args: dict[str, Any], budget_s: float) -> dict[str, Any]:
        """The DFM report: lint and geometry layers merged; writes ``<output dir>/dfm/rev-<rev>.json``."""
        from . import queries
        from .dfm import geometry, lint as lint_module
        from .dfm.issues import summarize
        from .dfm.profile import get_profile

        session = self._session(doc)
        profile = get_profile(session)
        if profile is None:
            raise ReifyOpError("OP_SCHEMA_INVALID", "set a dfm_profile first", detail={"path": "dfm_profile", "reason": "missing"},
                               hints=["apply a dfm_profile op (rulepack and material) before running dfm"])
        layers = list(args.get("layers") or ["lint", "geometry"])
        unknown = [layer for layer in layers if layer not in ("lint", "geometry")]
        if unknown:
            raise ReifyOpError("OP_SCHEMA_INVALID", f"unknown dfm layer(s) {unknown}", detail={"path": "layers", "reason": "unknown", "allowed": ["lint", "geometry"]})
        ctx = self._ctx(session)
        budget = queries.Budget(budget_s)
        lint_full = lint_module.evaluate_full(ctx) if "lint" in layers else None
        geometry_full = geometry.evaluate_geometry(ctx, budget) if "geometry" in layers else None
        merged = geometry.merge(lint_full, geometry_full)
        counts = summarize(merged["issues"], merged["passes"])["counts"]
        highlight, annotations = geometry.marks(session, merged["issues"])
        if geometry_full is not None:
            session.record_geometry_run(highlight, annotations)
        rev = session.rev
        report = {
            "rulepack": profile["rulepack"], "material": profile["material"], "rev": rev,
            "analyzer": geometry_full["analyzer"] if geometry_full else None,
            "asi": geometry_full["asi"] if geometry_full else None,
            "counts": counts, "issues": merged["issues"], "coverage": merged["coverage"],
            "highlight": highlight, "annotations": annotations,
        }
        report_path = Path(session.output).parent / "dfm" / f"rev-{rev}.json"
        try:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        except OSError as error:
            raise ReifyOpError("INTERNAL_ERROR", f"cannot write the DFM report: {error}", detail={"path": str(report_path)}) from error
        return {**report, "report_path": str(report_path)}

    def cmd_sweep(self, doc: str, args: dict[str, Any], budget_s: float) -> dict[str, Any]:
        from . import queries, sweep as sweep_module

        session = self._session(doc)
        ctx = self._ctx(session)
        result = sweep_module.sweep(ctx, args["param"], tuple(args["range"]), float(args["step"]), args["check"], bool(args.get("refine", False)), queries.Budget(budget_s))
        output = args.get("output")
        if output:
            result["pose"] = self._export_pose(session, ctx, args["param"], result["worstPose"], args["check"], Path(output))
        return result

    def _export_pose(self, session: Any, ctx: Any, param: str, value: float, check: dict[str, Any], output: Path) -> dict[str, Any]:
        """Export the worst pose to a temporary STEP and name the two nearest parts for highlighting."""
        from . import export as export_module
        from . import queries

        vs, prop = session.param_target(param)
        expression = next((expr for name, expr in vs.ExpressionEngine if name in (prop, f".{prop}")), None)
        original = getattr(vs, prop)
        original_value = float(original.Value if hasattr(original, "Value") else original)
        try:
            vs.setExpression(prop, None)
            setattr(vs, prop, value)
            session.recompute()
            export_module.write_step(session, output)
            args = check.get("args") or {}
            near = [args[key] for key in ("a", "b") if key in args]
            annotations = []
            for path in near:
                shape = queries.shape_of(ctx, path)
                centre = queries.centroid_of(shape)
                annotations.append({"text": path.split("/")[-1], "at": [round(centre.x, 4), round(centre.y, 4), round(centre.z, 4)]})
            return {"step": str(output), "annotations": annotations}
        finally:
            if expression:
                vs.setExpression(prop, expression)
            else:
                vs.setExpression(prop, None)
                setattr(vs, prop, original_value)
            session.recompute()

    def cmd_close(self, doc: str, args: dict[str, Any]) -> dict[str, Any]:
        session = self.sessions.pop(doc, None)
        if session is not None:
            session.close()
        return {"closed": session is not None}

    # ------------------------------------------------------------ dispatch
    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = request.get("id")
        op = request.get("op")
        doc = request.get("doc")
        args = request.get("args") or {}
        budget_s = float(request.get("budgetS") or 30)
        try:
            if op == "ping":
                return {"id": request_id, "ok": True, "result": {"pid": os.getpid()}}
            if not isinstance(doc, str) or not doc:
                raise ReifyOpError("BAD_REQUEST", "request needs 'doc'")
            method = getattr(self, f"cmd_{str(op).replace('-', '_')}", None)
            if method is None:
                raise ReifyOpError("BAD_REQUEST", f"unknown command {op!r}")
            if op in {"check", "sweep", "dfm"}:
                result = method(doc, args, budget_s)
            else:
                result = method(doc, args)
            return {"id": request_id, "ok": True, "result": result}
        except ReifyOpError as error:
            return {"id": request_id, "ok": False, "error": _error_wire(error)}
        except Exception as error:  # never let one request kill the worker
            return {
                "id": request_id, "ok": False,
                "error": {"code": "INTERNAL_ERROR", "message": f"{type(error).__name__}: {error}", "rolledBack": False,
                          "detail": {"traceback": traceback.format_exc()[-2000:]}},
            }


def main() -> int:
    worker = Worker()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            response = {"id": None, "ok": False, "error": {"code": "BAD_REQUEST", "message": f"invalid JSON: {error}", "rolledBack": False}}
        else:
            response = worker.handle(request)
        _PROTOCOL.write(json.dumps(response, ensure_ascii=False, default=str) + "\n")
        _PROTOCOL.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
