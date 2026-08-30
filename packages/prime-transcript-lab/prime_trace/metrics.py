from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime
from typing import Any

from .ipython_ops import activity_counts, analyze_ipython
from .parser import TraceBundle
from .util import intervals_union_seconds, parse_time, percentile, stable_json


def _usage_zero() -> dict[str, float]:
    return {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "total": 0, "cost": 0.0}


def _add_usage(target: dict[str, float], ev: dict[str, Any]) -> None:
    u = ev.get("usage") or {}
    for key in ("input", "output", "cache_read", "cache_write", "total"):
        target[key] += int(u.get(key) or 0)
    target["cost"] += float((ev.get("cost") or {}).get("total") or 0)


def _session_times(events: list[dict[str, Any]]) -> tuple[datetime | None, datetime | None]:
    times = [parse_time(e.get("timestamp")) for e in events]
    times = [t for t in times if t]
    return (min(times), max(times)) if times else (None, None)


def build_metrics(bundle: TraceBundle) -> dict[str, Any]:
    events = bundle.events
    by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in events:
        by_session[e["session_id"]].append(e)

    session_rows: list[dict[str, Any]] = []
    family_usage = _usage_zero()
    root_usage = _usage_zero()
    models = Counter()
    content_by_kind = Counter()

    for e in events:
        content_by_kind[e["kind"]] += int(e.get("content_est_tokens") or 0)
        if e["kind"] == "assistant":
            _add_usage(family_usage, e)
            if e["session_id"] == bundle.root_session_id:
                _add_usage(root_usage, e)
            model = e.get("model")
            if model:
                models[str(model)] += 1

    for s in bundle.sessions:
        es = by_session[s.session_id]
        start, end = _session_times(es)
        usage = _usage_zero()
        for e in es:
            if e["kind"] == "assistant":
                _add_usage(usage, e)
        session_rows.append({
            "session_id": s.session_id,
            "name": s.name,
            "depth": s.depth,
            "parent_session_id": s.parent_session_id,
            "path": str(s.path),
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
            "duration_s": (end - start).total_seconds() if start and end else 0.0,
            "assistant_calls": sum(1 for e in es if e["kind"] == "assistant"),
            "tool_calls": sum(1 for e in es if e["kind"] == "tool_call"),
            "tool_errors": sum(1 for e in es if e["kind"] == "tool_result" and e.get("is_error")),
            "compactions": sum(1 for e in es if e["kind"] == "compaction"),
            "usage": usage,
        })

    all_start, all_end = _session_times(events)
    root_start, root_end = _session_times(by_session[bundle.root_session_id])

    tool_stats_map: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "count": 0,
        "error_count": 0,
        "durations_s": [],
        "result_est_tokens": [],
        "result_chars": [],
    })
    result_by_call: dict[tuple[str, str], dict[str, Any]] = {}
    for e in events:
        if e["kind"] == "tool_result" and e.get("tool_call_id"):
            result_by_call[(e["session_id"], str(e["tool_call_id"]))] = e
    tool_calls: list[dict[str, Any]] = []
    signatures = Counter()
    for e in events:
        if e["kind"] != "tool_call":
            continue
        name = str(e.get("tool_name") or "unknown")
        st = tool_stats_map[name]
        st["count"] += 1
        d = (e.get("duration_ms") or 0) / 1000.0
        if d > 0:
            st["durations_s"].append(d)
        result = result_by_call.get((e["session_id"], str(e.get("tool_call_id"))))
        if result:
            tok = int(result.get("content_est_tokens") or 0)
            chars = int(result.get("content_chars") or len(result.get("text") or ""))
            st["result_est_tokens"].append(tok)
            st["result_chars"].append(chars)
            if result.get("is_error"):
                st["error_count"] += 1
        sig = f"{name}:{stable_json(e.get('arguments'))}"
        signatures[sig] += 1
        call_row = {
            "event_id": e["event_id"],
            "session_id": e["session_id"],
            "session_name": e["session_name"],
            "agent_depth": e["agent_depth"],
            "timestamp": e.get("timestamp"),
            "tool_name": name,
            "tool_call_id": e.get("tool_call_id"),
            "duration_s": d,
            "arguments": e.get("arguments"),
            "result_est_tokens": int(result.get("content_est_tokens") or 0) if result else 0,
            "result_chars": int(result.get("content_chars") or len(result.get("text") or "")) if result else 0,
            "is_error": bool(result.get("is_error")) if result else False,
            "result_event_id": result.get("event_id") if result else None,
        }
        if name.lower() == "ipython":
            call_row["ipython"] = analyze_ipython(e.get("arguments"))
        tool_calls.append(call_row)

    tool_stats: list[dict[str, Any]] = []
    for name, st in tool_stats_map.items():
        ds = st.pop("durations_s")
        toks = st.pop("result_est_tokens")
        chars = st.pop("result_chars")
        tool_stats.append({
            "tool_name": name,
            **st,
            "total_duration_s": sum(ds),
            "p50_duration_s": percentile(ds, 0.50),
            "p95_duration_s": percentile(ds, 0.95),
            "max_duration_s": max(ds) if ds else 0.0,
            "total_result_est_tokens": sum(toks),
            "p50_result_est_tokens": percentile([float(x) for x in toks], 0.50),
            "p95_result_est_tokens": percentile([float(x) for x in toks], 0.95),
            "max_result_est_tokens": max(toks) if toks else 0,
            "total_result_chars": sum(chars),
        })
    tool_stats.sort(key=lambda x: (-x["count"], -x["total_result_est_tokens"], x["tool_name"]))

    largest_results = sorted(tool_calls, key=lambda x: x["result_est_tokens"], reverse=True)[:25]
    longest_tools = sorted(tool_calls, key=lambda x: x["duration_s"], reverse=True)[:25]

    repeated_calls = []
    for sig, count in signatures.most_common():
        if count <= 1:
            continue
        name, args = sig.split(":", 1)
        repeated_calls.append({"tool_name": name, "count": count, "arguments": args[:1000]})
    repeated_calls = repeated_calls[:30]
    ipython_cells = [
        {**x["ipython"], **{k: x.get(k) for k in (
            "event_id", "session_id", "session_name", "agent_depth", "timestamp",
            "tool_call_id", "duration_s", "result_est_tokens", "result_chars", "is_error",
        )}}
        for x in tool_calls if x.get("ipython")
    ]
    observed_counts = activity_counts(ipython_cells)
    for call in tool_calls:
        if not call.get("ipython"):
            observed_counts[f"tool:{call['tool_name']}"] += 1
    ipython_activity_stats = [
        {"activity": name, "cell_count": count}
        for name, count in observed_counts.most_common()
    ]
    known_tool_counts = Counter(
        name for cell in ipython_cells for name in (cell.get("known_tool_calls") or [])
    )
    known_tool_stats = [
        {"tool": name, "call_count": count}
        for name, count in known_tool_counts.most_common()
    ]

    context_series = []
    first_time = all_start
    for e in events:
        if e["kind"] != "assistant":
            continue
        u = e.get("usage") or {}
        t = parse_time(e.get("timestamp"))
        prompt_tokens = int(u.get("input") or 0) + int(u.get("cache_read") or 0) + int(u.get("cache_write") or 0)
        context_series.append({
            "event_id": e["event_id"],
            "timestamp": e.get("timestamp"),
            "elapsed_s": (t - first_time).total_seconds() if t and first_time else 0.0,
            "session_id": e["session_id"],
            "session_name": e["session_name"],
            "agent_depth": e["agent_depth"],
            "model": e.get("model"),
            "input": int(u.get("input") or 0),
            "cache_read": int(u.get("cache_read") or 0),
            "cache_write": int(u.get("cache_write") or 0),
            "prompt_tokens": prompt_tokens,
            "output": int(u.get("output") or 0),
            "response_gap_s": (e.get("response_gap_ms") or 0) / 1000.0,
        })

    prompt_peak = max((x["prompt_tokens"] for x in context_series), default=0)

    # Root-time partition from observable intervals. This intentionally does not include
    # subagent durations because children can overlap the root and each other.
    root_events = by_session[bundle.root_session_id]
    model_intervals: list[tuple[datetime, datetime]] = []
    tool_intervals: list[tuple[datetime, datetime]] = []
    by_event_id = {e["event_id"]: e for e in root_events}
    for e in root_events:
        if e["kind"] == "assistant" and e.get("response_gap_from_event_id"):
            a = by_event_id.get(e["response_gap_from_event_id"])
            t0, t1 = parse_time(a.get("timestamp") if a else None), parse_time(e.get("timestamp"))
            if t0 and t1 and t1 >= t0:
                model_intervals.append((t0, t1))
        if e["kind"] == "tool_call" and e.get("result_event_id"):
            r = by_event_id.get(e["result_event_id"])
            t0, t1 = parse_time(e.get("timestamp")), parse_time(r.get("timestamp") if r else None)
            if t0 and t1 and t1 >= t0:
                tool_intervals.append((t0, t1))
    root_wall = (root_end - root_start).total_seconds() if root_start and root_end else 0.0
    model_union = intervals_union_seconds(model_intervals)
    tool_union = intervals_union_seconds(tool_intervals)
    other = max(0.0, root_wall - model_union - tool_union)

    child_attributed = _usage_zero()
    for e in by_session[bundle.root_session_id]:
        if e["kind"] == "child_usage_attributed":
            u = e.get("child_usage") or {}
            for key in ("input", "output", "cache_read", "cache_write", "total"):
                child_attributed[key] += int(u.get(key) or 0)

    return {
        "schema_version": 2,
        "root_session_id": bundle.root_session_id,
        "root_path": str(bundle.root_path),
        "summary": {
            "session_count": len(bundle.sessions),
            "subagent_count": max(0, len(bundle.sessions) - 1),
            "wall_time_s": (all_end - all_start).total_seconds() if all_start and all_end else 0.0,
            "root_wall_time_s": root_wall,
            "assistant_calls": sum(1 for e in events if e["kind"] == "assistant"),
            "tool_calls": len(tool_calls),
            "tool_errors": sum(1 for x in tool_calls if x["is_error"]),
            "compactions": sum(1 for e in events if e["kind"] == "compaction"),
            "branch_summaries": sum(1 for e in events if e["kind"] == "branch_summary"),
            "prompt_peak_tokens": prompt_peak,
            "family_usage": family_usage,
            "root_usage": root_usage,
            "root_child_usage_attributed": child_attributed,
            "models": dict(models),
        },
        "root_time_breakdown": {
            "model_response_gap_s": model_union,
            "tool_wait_s": tool_union,
            "other_or_idle_s": other,
            "note": "Model time is inferred from transcript timestamp gaps; tool wait is call→result wall time. Child agents overlap and are reported separately.",
        },
        "sessions": session_rows,
        "tool_stats": tool_stats,
        "tool_calls": tool_calls,
        "largest_tool_results": largest_results,
        "longest_tools": longest_tools,
        "repeated_calls": repeated_calls,
        "ipython_cells": ipython_cells,
        "ipython_activity_stats": ipython_activity_stats,
        "known_tool_stats": known_tool_stats,
        "context_series": context_series,
        "content_est_tokens_by_kind": dict(content_by_kind),
        "notes": {
            "api_usage_tokens": "Exact values copied from Prime assistant usage fields.",
            "content_est_tokens": "Provider-agnostic size estimate for attributing transcript payloads; not billing tokens.",
            "subagents": "Discovered through session header parentSession links within the scan directory.",
        },
    }
