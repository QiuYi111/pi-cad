from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from .export_md import write_markdown
from .metrics import build_metrics
from .parser import load_trace, write_events
from .report import write_report
from .tables import write_tables
from .util import compact_number, format_duration


def analyze(args: argparse.Namespace) -> int:
    session = Path(args.session).expanduser()
    if not session.exists():
        print(f"error: session not found: {session}", file=sys.stderr)
        return 2
    out = Path(args.out).expanduser() if args.out else Path.cwd() / f"{session.stem}-analysis"
    out.mkdir(parents=True, exist_ok=True)

    scan_dir = Path(args.scan_dir).expanduser() if args.scan_dir else None
    bundle = load_trace(session, scan_dir=scan_dir, include_children=not args.no_children)
    metrics = build_metrics(bundle)

    write_events(bundle, out / "events.jsonl")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
    write_markdown(bundle, metrics, out, inline_limit=args.inline_limit)
    write_report(metrics, out / "report.html")
    write_tables(metrics, out)

    summary = metrics["summary"]
    u = summary["family_usage"]
    print(f"written: {out.resolve()}")
    print(
        f"{summary['session_count']} sessions · {summary['subagent_count']} subagents · "
        f"{summary['tool_calls']} tool calls · {format_duration(summary['wall_time_s'])} wall"
    )
    print(
        f"prompt Σ {compact_number(u['input'] + u['cache_read'] + u['cache_write'])} · "
        f"output {compact_number(u['output'])} · peak prompt {compact_number(summary['prompt_peak_tokens'])}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="prime-trace", description="Forensic analyzer for Prime Agent JSONL sessions")
    sub = p.add_subparsers(dest="command")
    a = sub.add_parser("analyze", help="Generate HTML report + LLM/human-readable transcript")
    a.add_argument("session", help="Root Prime session .jsonl")
    a.add_argument("-o", "--out", help="Output directory (default: <session>-analysis)")
    a.add_argument("--scan-dir", help="Directory to recursively scan for child sessions; default: root session directory")
    a.add_argument("--no-children", action="store_true", help="Analyze only the supplied session")
    a.add_argument("--inline-limit", type=int, default=12_000, help="Externalize Markdown payloads larger than this many characters")
    a.set_defaults(func=analyze)
    return p


def main() -> None:
    parser = build_parser()
    argv = sys.argv[1:]
    # Convenience: `prime-trace session.jsonl` means analyze.
    if argv and argv[0] not in {"analyze", "-h", "--help"}:
        argv = ["analyze", *argv]
    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        raise SystemExit(1)
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
