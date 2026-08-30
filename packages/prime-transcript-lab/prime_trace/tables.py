from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any


def _write(path: Path, fieldnames: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for row in rows:
            cooked = {}
            for key in fieldnames:
                value = row.get(key)
                if isinstance(value, (dict, list)):
                    value = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
                cooked[key] = value
            w.writerow(cooked)


def write_tables(metrics: dict[str, Any], out_dir: Path) -> None:
    tables = out_dir / "tables"
    session_rows = []
    for s in metrics["sessions"]:
        u = s["usage"]
        session_rows.append({
            **{k: s.get(k) for k in ["session_id", "name", "depth", "parent_session_id", "start", "end", "duration_s", "assistant_calls", "tool_calls", "tool_errors", "compactions", "path"]},
            "input": u["input"],
            "cache_read": u["cache_read"],
            "cache_write": u["cache_write"],
            "prompt_tokens": u["input"] + u["cache_read"] + u["cache_write"],
            "output": u["output"],
            "total_tokens": u["total"],
            "cost": u["cost"],
        })
    _write(tables / "sessions.csv", list(session_rows[0].keys()) if session_rows else ["session_id"], session_rows)

    assistant_rows = []
    for x in metrics["context_series"]:
        assistant_rows.append({
            "event_id": x["event_id"],
            "timestamp": x["timestamp"],
            "elapsed_s": x["elapsed_s"],
            "session_id": x["session_id"],
            "session_name": x["session_name"],
            "agent_depth": x["agent_depth"],
            "model": x["model"],
            "input": x["input"],
            "cache_read": x["cache_read"],
            "cache_write": x["cache_write"],
            "prompt_tokens": x["prompt_tokens"],
            "output": x["output"],
            "response_gap_s": x["response_gap_s"],
        })
    _write(tables / "assistant_calls.csv", list(assistant_rows[0].keys()) if assistant_rows else ["event_id"], assistant_rows)

    tool_rows = []
    for x in metrics["tool_calls"]:
        tool_rows.append({
            "event_id": x["event_id"],
            "timestamp": x["timestamp"],
            "session_id": x["session_id"],
            "session_name": x["session_name"],
            "agent_depth": x["agent_depth"],
            "tool_name": x["tool_name"],
            "tool_call_id": x["tool_call_id"],
            "duration_s": x["duration_s"],
            "result_est_tokens": x["result_est_tokens"],
            "result_chars": x["result_chars"],
            "is_error": x["is_error"],
            "arguments": x["arguments"],
            "result_event_id": x["result_event_id"],
            "ipython_summary": (x.get("ipython") or {}).get("summary"),
            "ipython_activities": (x.get("ipython") or {}).get("activities"),
            "ipython_style": (x.get("ipython") or {}).get("style"),
            "ipython_confidence": (x.get("ipython") or {}).get("confidence"),
        })
    _write(tables / "tool_calls.csv", list(tool_rows[0].keys()) if tool_rows else ["event_id"], tool_rows)

    cells = metrics.get("ipython_cells") or []
    fields = [
        "event_id", "timestamp", "session_id", "session_name", "agent_depth", "tool_call_id",
        "duration_s", "result_est_tokens", "result_chars", "is_error", "activities",
        "primary_activity", "style", "confidence", "summary", "code_lines", "code_chars",
        "statement_count", "commands", "paths", "imports", "calls", "known_tools", "known_tool_calls", "evidence", "parse_error", "code",
    ]
    _write(tables / "ipython_cells.csv", fields, cells)
