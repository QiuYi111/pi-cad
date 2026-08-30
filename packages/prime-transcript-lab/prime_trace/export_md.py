from __future__ import annotations

import base64
import json
import mimetypes
from collections import defaultdict
from pathlib import Path
from typing import Any

from .parser import TraceBundle
from .util import compact_number, format_duration, safe_name, sha256_text, stable_json


def _artifact_for_text(artifacts_dir: Path, text: str, label: str) -> Path:
    digest = sha256_text(text)[:16]
    path = artifacts_dir / f"{digest}-{safe_name(label, 48)}.txt"
    if not path.exists():
        path.write_text(text, encoding="utf-8")
    return path


def _artifact_for_image(artifacts_dir: Path, data: str, mime_type: str, label: str) -> Path | None:
    try:
        raw = base64.b64decode(data, validate=False)
    except Exception:
        return None
    ext = mimetypes.guess_extension(mime_type) or ".bin"
    digest = sha256_text(data)[:16]
    path = artifacts_dir / f"{digest}-{safe_name(label, 36)}{ext}"
    if not path.exists():
        path.write_bytes(raw)
    return path


def _preview(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    half = max(1000, limit // 2)
    return text[:half] + "\n\n… [middle omitted] …\n\n" + text[-half:]


def _render_payload(text: str, out_dir: Path, artifacts_dir: Path, label: str, inline_limit: int, language: str = "text") -> str:
    if not text:
        return ""
    if len(text) <= inline_limit:
        return f"```{language}\n{text}\n```"
    path = _artifact_for_text(artifacts_dir, text, label)
    rel = path.relative_to(out_dir)
    preview = _preview(text, min(4000, inline_limit))
    return (
        f"> Large payload externalized: `{rel}` · {len(text):,} chars\n\n"
        f"```{language}\n{preview}\n```"
    )


def _event_heading(ev: dict[str, Any], root_start: float | None) -> str:
    t = ev.get("timestamp_unix")
    elapsed = (t - root_start) if t is not None and root_start is not None else 0.0
    mins = int(elapsed // 60)
    secs = elapsed % 60
    agent = "root" if ev.get("agent_depth") == 0 else ev.get("session_name", "child")
    active = "" if ev.get("on_active_branch", True) else " · inactive-branch"
    return f"## +{mins:02d}:{secs:04.1f} · {agent} · {ev['kind']}{active} {{#{safe_name(ev['event_id'], 120)}}}"


def _render_event(ev: dict[str, Any], out_dir: Path, artifacts_dir: Path, inline_limit: int, root_start: float | None) -> str:
    lines = [_event_heading(ev, root_start)]
    kind = ev["kind"]

    if kind == "assistant":
        u = ev.get("usage") or {}
        prompt = int(u.get("input") or 0) + int(u.get("cache_read") or 0) + int(u.get("cache_write") or 0)
        lines.append(
            f"model: `{ev.get('provider') or '?'} / {ev.get('model') or '?'}` · "
            f"prompt {compact_number(prompt)} · output {compact_number(u.get('output', 0))} · "
            f"response-gap≈{format_duration((ev.get('response_gap_ms') or 0)/1000)}"
        )
        if ev.get("thinking"):
            lines += ["", "<details><summary>Thinking</summary>", "", _render_payload(str(ev["thinking"]), out_dir, artifacts_dir, ev["event_id"] + "-thinking", inline_limit, "text"), "", "</details>"]
        if ev.get("text"):
            lines += ["", str(ev["text"])]
        if ev.get("error"):
            lines += ["", f"**ERROR:** {ev['error']}"]

    elif kind == "tool_call":
        lines.append(
            f"tool: `{ev.get('tool_name')}` · call `{ev.get('tool_call_id')}` · "
            f"duration {format_duration((ev.get('duration_ms') or 0)/1000)}"
        )
        args = stable_json(ev.get("arguments"))
        lines += ["", _render_payload(args, out_dir, artifacts_dir, ev["event_id"] + "-args", inline_limit, "json")]

    elif kind == "tool_result":
        status = "ERROR" if ev.get("is_error") else "ok"
        lines.append(
            f"tool: `{ev.get('tool_name')}` · {status} · estimated payload {compact_number(ev.get('content_est_tokens', 0))} tok"
        )
        text = str(ev.get("text") or "")
        if text:
            lines += ["", _render_payload(text, out_dir, artifacts_dir, ev["event_id"] + "-result", inline_limit, "text")]

    elif kind == "user":
        lines += ["", str(ev.get("text") or "")]

    elif kind == "compaction":
        lines.append(f"tokens before: {compact_number(ev.get('tokens_before', 0))}")
        if ev.get("text"):
            lines += ["", str(ev["text"])]

    elif kind == "branch_summary":
        lines.append(f"from entry: `{ev.get('from_id')}`")
        if ev.get("text"):
            lines += ["", str(ev["text"])]

    elif kind == "bash_execution":
        lines.append(f"exit: `{ev.get('exit_code')}` · truncated: `{ev.get('truncated')}`")
        if ev.get("command"):
            lines += ["", "```bash", str(ev["command"]), "```"]
        if ev.get("text"):
            lines += ["", _render_payload(str(ev["text"]), out_dir, artifacts_dir, ev["event_id"] + "-bash", inline_limit, "text")]

    elif kind == "child_usage_attributed":
        lines.append(f"child usage attribution: `{json.dumps(ev.get('child_usage') or {}, ensure_ascii=False)}`")

    else:
        text = ev.get("text")
        if text:
            lines += ["", _render_payload(str(text), out_dir, artifacts_dir, ev["event_id"], inline_limit, "text")]
        elif ev.get("metadata"):
            lines += ["", _render_payload(stable_json(ev["metadata"]), out_dir, artifacts_dir, ev["event_id"], inline_limit, "json")]

    for idx, img in enumerate(ev.get("images") or []):
        data = img.get("data")
        if not data:
            continue
        p = _artifact_for_image(artifacts_dir, data, img.get("mime_type") or "application/octet-stream", f"{ev['event_id']}-{idx}")
        if p:
            lines += ["", f"image: `{p.relative_to(out_dir)}`"]

    return "\n".join(lines).rstrip() + "\n"


def write_markdown(bundle: TraceBundle, metrics: dict[str, Any], out_dir: Path, inline_limit: int = 12_000) -> None:
    artifacts = out_dir / "artifacts"
    agents_dir = out_dir / "agents"
    artifacts.mkdir(parents=True, exist_ok=True)
    agents_dir.mkdir(parents=True, exist_ok=True)

    summary = metrics["summary"]
    fam = summary["family_usage"]
    root_start = min((e.get("timestamp_unix") for e in bundle.events if e.get("timestamp_unix") is not None), default=None)

    header = [
        "# Prime Agent transcript",
        "",
        f"- root session: `{bundle.root_session_id}`",
        f"- wall time: {format_duration(summary['wall_time_s'])}",
        f"- sessions: {summary['session_count']} ({summary['subagent_count']} subagents)",
        f"- API usage: input {compact_number(fam['input'])}, cache-read {compact_number(fam['cache_read'])}, cache-write {compact_number(fam['cache_write'])}, output {compact_number(fam['output'])}",
        f"- tool calls: {summary['tool_calls']} · errors: {summary['tool_errors']} · compactions: {summary['compactions']}",
        f"- peak prompt load: {compact_number(summary['prompt_peak_tokens'])}",
        "",
        "> Exact token numbers come from Prime `usage`. Payload token sizes are estimates. Large payloads are externalized without being discarded.",
        "",
        "## Agent map",
        "",
    ]
    for s in metrics["sessions"]:
        indent = "  " * int(s["depth"])
        header.append(
            f"- {indent}`{s['session_id'][:8]}` {s['name']} · {format_duration(s['duration_s'])} · "
            f"{s['assistant_calls']} model calls · {s['tool_calls']} tools"
        )
    header += ["", "# Global timeline", ""]

    body = ["\n".join(header)]
    for ev in bundle.events:
        body.append(_render_event(ev, out_dir, artifacts, inline_limit, root_start))
    (out_dir / "transcript.md").write_text("\n".join(body), encoding="utf-8")

    by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for ev in bundle.events:
        by_session[ev["session_id"]].append(ev)
    for session in bundle.sessions:
        s_metrics = next(x for x in metrics["sessions"] if x["session_id"] == session.session_id)
        lines = [
            f"# Agent: {session.name}",
            "",
            f"- session: `{session.session_id}`",
            f"- parent: `{session.parent_session_id or 'none'}`",
            f"- depth: {session.depth}",
            f"- duration: {format_duration(s_metrics['duration_s'])}",
            "",
        ]
        local_start = min((e.get("timestamp_unix") for e in by_session[session.session_id] if e.get("timestamp_unix") is not None), default=root_start)
        for ev in by_session[session.session_id]:
            lines.append(_render_event(ev, out_dir, artifacts, inline_limit, local_start))
        name = f"{session.depth:02d}-{safe_name(session.name, 48)}-{session.session_id[:8]}.md"
        (agents_dir / name).write_text("\n".join(lines), encoding="utf-8")
