"""Pose sweeps: vary one parameter, run a check at every sample (imports FreeCAD)."""

from __future__ import annotations

from typing import Any

from .errors import ReifyOpError
from .exprs import is_expression
from .ops.context import OpContext
from .queries import Budget, run_check

MAX_POINTS = 2000
DETAIL_POINTS = 200


def _frange(low: float, high: float, step: float) -> list[float]:
    if step <= 0:
        raise ReifyOpError("OP_SCHEMA_INVALID", "step must be positive", detail={"path": "step", "reason": "not positive"})
    count = int(round((high - low) / step))
    values = [low + i * step for i in range(count + 1)]
    if values[-1] < high - 1e-9:
        values.append(high)
    if len(values) > MAX_POINTS:
        raise ReifyOpError("OP_SCHEMA_INVALID", f"{len(values)} samples exceed the limit of {MAX_POINTS}", detail={"path": "step", "reason": "too many samples"},
                           hints=["use a larger step, then refine"])
    return values


def _failing(kind: str, value: float, args: dict[str, Any]) -> bool:
    if "fail_below" in args:
        return value < float(args["fail_below"])
    if "fail_above" in args:
        return value > float(args["fail_above"])
    if kind == "clearance":
        return value <= 1e-9
    if kind == "interference":
        return value > 1e-9
    return False


class _Runner:
    def __init__(self, ctx: Any, name: str, kind: str, args: dict[str, Any], budget: Budget) -> None:
        self.ctx, self.name, self.kind, self.args, self.budget = ctx, name, kind, args, budget
        self.vs = ctx.session.params_object()
        self.cache: dict[float, float] = {}

    def at(self, parameter: float) -> float:
        key = round(parameter, 12)
        if key in self.cache:
            return self.cache[key]
        if self.budget.expired():
            raise _OutOfTime()
        self.vs.setExpression(self.name, None)
        setattr(self.vs, self.name, parameter)
        self.ctx.session.recompute()
        value = float(run_check(self.ctx, self.kind, self.args, self.budget)["value"])
        self.cache[key] = value
        return value

    def fails(self, parameter: float) -> bool:
        return _failing(self.kind, self.at(parameter), self.args)


class _OutOfTime(Exception):
    pass


def sweep(ctx: OpContext, param: str, span: tuple[float, float], step: float, check: dict[str, Any], refine: bool, budget: Budget) -> dict[str, Any]:
    session = ctx.session
    if param not in session.param_names():
        raise ReifyOpError("TARGET_NOT_FOUND", f"no parameter named '{param}'", target=param,
                           detail={"target": param, "known": sorted(session.param_names())})
    kind = check["kind"]
    args = dict(check.get("args") or {})
    runner = _Runner(ctx, param, kind, args, budget)
    vs = runner.vs
    original_expression = None
    for prop, expr in vs.ExpressionEngine:
        if prop == param or prop == f".{param}":
            original_expression = expr
    original_value = float(getattr(vs, param).Value if hasattr(getattr(vs, param), "Value") else getattr(vs, param))
    low, high = float(span[0]), float(span[1])
    values = _frange(low, high, step)
    truncated = False
    samples: list[tuple[float, float]] = []
    try:
        for parameter in values:
            samples.append((parameter, runner.at(parameter)))
        failures = [fails for fails in (_failing(kind, v, args) for _p, v in samples)]
        refinements = 0
        if refine:
            try:
                refinements = _refine(runner, samples, failures, step)
            except _OutOfTime:
                truncated = True
        points = sorted(runner.cache.items())
    except _OutOfTime:
        raise ReifyOpError("BUDGET_EXCEEDED", "sweep ran out of time", detail={"sampled": len(samples), "total": len(values)},
                           hints=["increase budget_s", "use a larger step"])
    finally:
        _restore(vs, param, original_value, original_expression)
        session.recompute()
    lowest = min(points, key=lambda item: item[1])
    flags = [(p, _failing(kind, v, args)) for p, v in points]
    intervals = _intervals(flags)
    first = next((p for p, failed in flags if failed), None)
    result: dict[str, Any] = {
        "kind": kind, "param": param, "samples": len(points), "range": [low, high], "step": step,
        "min": {"value": round(lowest[1], 6), "at": round(lowest[0], 6)},
        "firstFailure": None if first is None else round(first, 6),
        "failureIntervals": [[round(a, 6), round(b, 6)] for a, b in intervals],
        "worstPose": round(lowest[0], 6),
        "refined": refine and not truncated, "refinementEvaluations": refinements,
        "unit": "mm" if kind in {"clearance", "wall_thickness"} else None,
    }
    if truncated:
        result["truncated"] = True
    if len(points) <= DETAIL_POINTS:
        result["points"] = [[round(p, 6), round(v, 6)] for p, v in points]
    return result


def _restore(vs: Any, name: str, value: float, expression: str | None) -> None:
    if expression:
        vs.setExpression(name, expression)
    else:
        vs.setExpression(name, None)
        setattr(vs, name, value)


def _intervals(flags: list[tuple[float, bool]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    start: float | None = None
    last: float | None = None
    for parameter, failed in flags:
        if failed and start is None:
            start = parameter
        if failed:
            last = parameter
        if not failed and start is not None:
            out.append((start, last if last is not None else start))
            start = None
    if start is not None:
        out.append((start, last if last is not None else start))
    return out


def _refine(runner: _Runner, samples: list[tuple[float, float]], failures: list[bool], step: float) -> int:
    """Bisect every pass/fail boundary and densify around the minimum, down to step/8."""
    before = len(runner.cache)
    target = step / 8.0
    for i in range(len(samples) - 1):
        if failures[i] == failures[i + 1]:
            continue
        lo, hi = samples[i][0], samples[i + 1][0]
        lo_fails = failures[i]
        while hi - lo > target + 1e-12:
            mid = (lo + hi) / 2.0
            if runner.fails(mid) == lo_fails:
                lo = mid
            else:
                hi = mid
    lowest = min(samples, key=lambda item: item[1])
    window_low, window_high = lowest[0] - step, lowest[0] + step
    parameter = window_low
    while parameter <= window_high + 1e-12:
        runner.at(parameter)
        parameter += target
    return len(runner.cache) - before
