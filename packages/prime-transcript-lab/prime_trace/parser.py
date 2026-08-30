from __future__ import annotations

import base64
import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .util import estimate_tokens, iso, parse_time, read_jsonl, safe_name, sha256_text, stable_json


@dataclass
class SessionData:
    path: Path
    header: dict[str, Any]
    entries: list[dict[str, Any]]
    session_id: str
    parent_path: Path | None = None
    parent_session_id: str | None = None
    depth: int = 0
    name: str = ""
    active_ids: set[str] = field(default_factory=set)


@dataclass
class TraceBundle:
    root_path: Path
    root_session_id: str
    sessions: list[SessionData]
    events: list[dict[str, Any]]


def _header_for(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            line = f.readline().strip()
        if not line:
            return None
        obj = json.loads(line)
        if isinstance(obj, dict) and obj.get("type") == "session" and obj.get("id"):
            return obj
    except Exception:
        return None
    return None


def _resolve_parent(child_path: Path, parent_value: Any) -> Path | None:
    if not isinstance(parent_value, str) or not parent_value.strip():
        return None
    p = Path(parent_value).expanduser()
    if not p.is_absolute():
        p = child_path.parent / p
    try:
        return p.resolve()
    except Exception:
        return p.absolute()


def _active_branch_ids(entries: list[dict[str, Any]]) -> set[str]:
    by_id: dict[str, dict[str, Any]] = {
        str(e["id"]): e for e in entries if isinstance(e.get("id"), str)
    }
    leaf_id: str | None = None
    for e in entries:
        if isinstance(e.get("id"), str):
            leaf_id = e["id"]
    active: set[str] = set()
    seen: set[str] = set()
    cur = leaf_id
    while cur and cur not in seen:
        seen.add(cur)
        active.add(cur)
        parent = by_id.get(cur, {}).get("parentId")
        cur = parent if isinstance(parent, str) else None
    return active


def _content_parts(content: Any) -> tuple[str, list[dict[str, Any]], str]:
    """Return text, image descriptors, thinking text."""
    if isinstance(content, str):
        return content, [], ""
    if not isinstance(content, list):
        return stable_json(content) if content is not None else "", [], ""
    texts: list[str] = []
    images: list[dict[str, Any]] = []
    thinking: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            texts.append(str(block))
            continue
        kind = block.get("type")
        if kind == "text":
            texts.append(str(block.get("text", "")))
        elif kind == "thinking":
            thinking.append(str(block.get("thinking", "")))
        elif kind == "image":
            data = block.get("data")
            images.append({
                "mime_type": block.get("mimeType") or block.get("mime_type") or "application/octet-stream",
                "data": data if isinstance(data, str) else None,
                "bytes_est": int(len(data) * 0.75) if isinstance(data, str) else 0,
            })
        elif kind != "toolCall":
            texts.append(stable_json(block))
    return "\n".join(x for x in texts if x), images, "\n".join(x for x in thinking if x)


def _tool_calls(content: Any) -> list[dict[str, Any]]:
    if not isinstance(content, list):
        return []
    return [b for b in content if isinstance(b, dict) and b.get("type") == "toolCall"]


def _session_name(session: SessionData) -> str:
    for e in reversed(session.entries):
        if e.get("type") == "session_info" and isinstance(e.get("name"), str) and e["name"].strip():
            return e["name"].strip()
    for e in session.entries:
        if e.get("type") != "message":
            continue
        m = e.get("message") or {}
        if isinstance(m, dict) and m.get("role") == "user":
            text, _, _ = _content_parts(m.get("content"))
            text = re.sub(r"^\[task from parent\]\s*", "", text.strip(), flags=re.I)
            if text:
                first = text.splitlines()[0].strip()
                return first[:80]
    return session.session_id[:8]


def discover_sessions(root: Path, scan_dir: Path | None = None, include_children: bool = True) -> list[SessionData]:
    root = root.expanduser().resolve()
    root_header = _header_for(root)
    if not root_header:
        raise ValueError(f"Not a Prime session JSONL (missing session header): {root}")

    candidate_paths: set[Path] = {root}
    if include_children:
        base = (scan_dir.expanduser().resolve() if scan_dir else root.parent)
        if base.exists():
            for p in base.rglob("*.jsonl"):
                try:
                    candidate_paths.add(p.resolve())
                except Exception:
                    candidate_paths.add(p.absolute())

    headers: dict[Path, dict[str, Any]] = {}
    parent_paths: dict[Path, Path | None] = {}
    for p in candidate_paths:
        h = _header_for(p)
        if not h:
            continue
        headers[p] = h
        parent_paths[p] = _resolve_parent(p, h.get("parentSession"))

    # Keep root and every descendant whose parent chain reaches root.
    kept: set[Path] = {root}
    if include_children:
        changed = True
        while changed:
            changed = False
            for p, parent in parent_paths.items():
                if p not in kept and parent in kept:
                    kept.add(p)
                    changed = True

    sessions: list[SessionData] = []
    sid_by_path = {p: str(headers[p].get("id")) for p in kept if p in headers}
    for p in kept:
        h = headers[p]
        entries = read_jsonl(p)
        parent_path = parent_paths.get(p)
        session = SessionData(
            path=p,
            header=h,
            entries=entries,
            session_id=str(h.get("id")),
            parent_path=parent_path if parent_path in kept else None,
            parent_session_id=sid_by_path.get(parent_path) if parent_path else None,
            active_ids=_active_branch_ids(entries),
        )
        sessions.append(session)

    by_id = {s.session_id: s for s in sessions}
    for s in sessions:
        depth = 0
        cur = s.parent_session_id
        seen: set[str] = set()
        while cur and cur not in seen and cur in by_id:
            seen.add(cur)
            depth += 1
            cur = by_id[cur].parent_session_id
        s.depth = depth
        s.name = _session_name(s)

    sessions.sort(key=lambda s: (s.depth, s.header.get("timestamp", ""), s.session_id))
    return sessions


def _event_base(session: SessionData, entry: dict[str, Any], kind: str, role: str | None = None) -> dict[str, Any]:
    dt = parse_time(entry.get("timestamp"))
    entry_id = str(entry.get("id") or f"line-{entry.get('_line', 0)}")
    return {
        "event_id": f"{session.session_id}:{entry_id}:{kind}",
        "entry_id": entry_id,
        "line": entry.get("_line"),
        "session_id": session.session_id,
        "session_name": session.name,
        "parent_session_id": session.parent_session_id,
        "agent_depth": session.depth,
        "kind": kind,
        "role": role,
        "timestamp": iso(dt),
        "timestamp_unix": dt.timestamp() if dt else None,
        "on_active_branch": entry_id in session.active_ids,
        "parent_entry_id": entry.get("parentId"),
        "source_path": str(session.path),
    }


def events_for_session(session: SessionData) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for entry in session.entries:
        etype = entry.get("type")
        if etype in {"session", "_parse_error"}:
            if etype == "_parse_error":
                ev = _event_base(session, entry, "parse_error")
                ev.update({"error": entry.get("error"), "text": entry.get("raw", "")})
                events.append(ev)
            continue

        if etype == "message":
            m = entry.get("message") if isinstance(entry.get("message"), dict) else {}
            role = str(m.get("role") or "unknown")
            text, images, thinking = _content_parts(m.get("content"))

            if role == "assistant":
                ev = _event_base(session, entry, "assistant", role)
                usage = m.get("usage") if isinstance(m.get("usage"), dict) else {}
                cost = usage.get("cost") if isinstance(usage.get("cost"), dict) else {}
                ev.update({
                    "text": text,
                    "thinking": thinking,
                    "images": images,
                    "model": m.get("model"),
                    "provider": m.get("provider"),
                    "api": m.get("api"),
                    "stop_reason": m.get("stopReason"),
                    "error": m.get("errorMessage"),
                    "usage": {
                        "input": int(usage.get("input") or 0),
                        "output": int(usage.get("output") or 0),
                        "cache_read": int(usage.get("cacheRead") or 0),
                        "cache_write": int(usage.get("cacheWrite") or 0),
                        "total": int(usage.get("totalTokens") or 0),
                    },
                    "cost": {
                        "input": float(cost.get("input") or 0),
                        "output": float(cost.get("output") or 0),
                        "cache_read": float(cost.get("cacheRead") or 0),
                        "cache_write": float(cost.get("cacheWrite") or 0),
                        "total": float(cost.get("total") or 0),
                    },
                })
                ev["content_est_tokens"] = estimate_tokens(text) + estimate_tokens(thinking)
                events.append(ev)

                for idx, call in enumerate(_tool_calls(m.get("content"))):
                    tev = _event_base(session, entry, "tool_call", "assistant")
                    tev["event_id"] += f":{idx}"
                    args = call.get("arguments") if isinstance(call.get("arguments"), dict) else call.get("arguments")
                    tev.update({
                        "tool_call_id": call.get("id"),
                        "tool_name": call.get("name") or "unknown",
                        "arguments": args,
                        "arguments_text": stable_json(args),
                        "content_est_tokens": estimate_tokens(stable_json(args)),
                    })
                    events.append(tev)
                continue

            if role == "toolResult":
                ev = _event_base(session, entry, "tool_result", role)
                ev.update({
                    "tool_call_id": m.get("toolCallId"),
                    "tool_name": m.get("toolName") or "unknown",
                    "text": text,
                    "images": images,
                    "details": m.get("details"),
                    "is_error": bool(m.get("isError")),
                    "content_est_tokens": estimate_tokens(text),
                    "content_chars": len(text),
                })
                events.append(ev)
                continue

            if role == "bashExecution":
                ev = _event_base(session, entry, "bash_execution", role)
                output = str(m.get("output") or "")
                ev.update({
                    "command": m.get("command"),
                    "text": output,
                    "exit_code": m.get("exitCode"),
                    "cancelled": bool(m.get("cancelled")),
                    "truncated": bool(m.get("truncated")),
                    "full_output_path": m.get("fullOutputPath"),
                    "exclude_from_context": bool(m.get("excludeFromContext")),
                    "content_est_tokens": estimate_tokens(output),
                })
                events.append(ev)
                continue

            kind = "user" if role == "user" else ("custom_message" if role == "custom" else role.lower())
            ev = _event_base(session, entry, kind, role)
            ev.update({
                "text": text,
                "thinking": thinking,
                "images": images,
                "content_est_tokens": estimate_tokens(text) + estimate_tokens(thinking),
            })
            events.append(ev)
            continue

        if etype == "compaction":
            ev = _event_base(session, entry, "compaction")
            summary = str(entry.get("summary") or "")
            ev.update({
                "text": summary,
                "tokens_before": int(entry.get("tokensBefore") or 0),
                "first_kept_entry_id": entry.get("firstKeptEntryId"),
                "details": entry.get("details"),
                "content_est_tokens": estimate_tokens(summary),
            })
            events.append(ev)
            continue

        if etype == "branch_summary":
            ev = _event_base(session, entry, "branch_summary")
            summary = str(entry.get("summary") or "")
            ev.update({"text": summary, "from_id": entry.get("fromId"), "content_est_tokens": estimate_tokens(summary)})
            events.append(ev)
            continue

        if etype == "custom_message":
            text, images, _ = _content_parts(entry.get("content"))
            ev = _event_base(session, entry, "custom_message")
            ev.update({
                "custom_type": entry.get("customType"),
                "display": entry.get("display"),
                "text": text,
                "images": images,
                "details": entry.get("details"),
                "content_est_tokens": estimate_tokens(text),
            })
            events.append(ev)
            continue

        if etype == "child_usage_attributed":
            ev = _event_base(session, entry, "child_usage_attributed")
            u = entry.get("childUsage") if isinstance(entry.get("childUsage"), dict) else {}
            ev.update({
                "target_id": entry.get("targetId"),
                "child_usage": {
                    "input": int(u.get("input") or 0),
                    "output": int(u.get("output") or 0),
                    "cache_read": int(u.get("cacheRead") or 0),
                    "cache_write": int(u.get("cacheWrite") or 0),
                    "total": int(u.get("totalTokens") or 0),
                },
            })
            events.append(ev)
            continue

        ev = _event_base(session, entry, str(etype or "unknown"))
        # Preserve small metadata without duplicating tree/session fields.
        metadata = {k: v for k, v in entry.items() if k not in {"type", "id", "parentId", "timestamp", "_line"}}
        ev["metadata"] = metadata
        ev["content_est_tokens"] = estimate_tokens(stable_json(metadata))
        events.append(ev)

    # Pair tool calls/results and calculate observable latency.
    calls: dict[str, dict[str, Any]] = {}
    for ev in events:
        if ev["kind"] == "tool_call" and ev.get("tool_call_id"):
            calls[str(ev["tool_call_id"])] = ev
        elif ev["kind"] == "tool_result" and ev.get("tool_call_id"):
            call = calls.get(str(ev["tool_call_id"]))
            if call and call.get("timestamp_unix") is not None and ev.get("timestamp_unix") is not None:
                ms = max(0.0, (ev["timestamp_unix"] - call["timestamp_unix"]) * 1000.0)
                call["duration_ms"] = ms
                call["result_event_id"] = ev["event_id"]
                ev["duration_ms"] = ms
                ev["call_event_id"] = call["event_id"]

    # Infer model response gaps: prompt-bearing event -> next assistant in same session.
    prompt_kinds = {"user", "tool_result", "custom_message", "branch_summary", "compaction"}
    ordered = sorted(events, key=lambda x: (x.get("timestamp_unix") or 0, x.get("line") or 0, x["kind"]))
    last_prompt: dict[str, Any] | None = None
    for ev in ordered:
        if ev["kind"] in prompt_kinds:
            last_prompt = ev
        elif ev["kind"] == "assistant" and last_prompt and last_prompt.get("timestamp_unix") is not None and ev.get("timestamp_unix") is not None:
            gap_ms = max(0.0, (ev["timestamp_unix"] - last_prompt["timestamp_unix"]) * 1000.0)
            ev["response_gap_ms"] = gap_ms
            ev["response_gap_from_event_id"] = last_prompt["event_id"]
            last_prompt = None

    return events


def load_trace(root: Path, scan_dir: Path | None = None, include_children: bool = True) -> TraceBundle:
    sessions = discover_sessions(root, scan_dir=scan_dir, include_children=include_children)
    events: list[dict[str, Any]] = []
    for s in sessions:
        events.extend(events_for_session(s))
    events.sort(key=lambda x: (
        x.get("timestamp_unix") if x.get("timestamp_unix") is not None else float("inf"),
        x.get("agent_depth") or 0,
        x.get("line") or 0,
        x.get("kind") or "",
    ))
    root_id = next(s.session_id for s in sessions if s.path.resolve() == root.expanduser().resolve())
    return TraceBundle(root_path=root.expanduser().resolve(), root_session_id=root_id, sessions=sessions, events=events)


def write_events(bundle: TraceBundle, path: Path) -> None:
    with path.open("w", encoding="utf-8") as f:
        for ev in bundle.events:
            clean = dict(ev)
            # Do not duplicate base64 image blobs into canonical events.jsonl.
            if clean.get("images"):
                clean["images"] = [
                    {k: v for k, v in img.items() if k != "data"}
                    for img in clean["images"]
                ]
            f.write(json.dumps(clean, ensure_ascii=False, default=str) + "\n")
