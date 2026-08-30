from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


def parse_time(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # Prime message timestamps are unix milliseconds.
        sec = float(value) / 1000.0 if value > 10_000_000_000 else float(value)
        try:
            return datetime.fromtimestamp(sec, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            dt = datetime.fromisoformat(text)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except ValueError:
            return None
    return None


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if dt else None


def estimate_tokens(text: str | None) -> int:
    """Cheap provider-agnostic estimate for payload sizing, not billing/accounting.

    API usage tokens in Prime messages are used wherever available. This estimator is
    only for content attribution such as tool-result size.
    """
    if not text:
        return 0
    ascii_count = sum(1 for ch in text if ord(ch) < 128)
    non_ascii = len(text) - ascii_count
    # Code/English tends toward ~4 chars/token; CJK tends toward ~1-2 chars/token.
    return max(1, math.ceil(ascii_count / 4.0 + non_ascii / 1.5))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def stable_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    except Exception:
        return repr(value)


def format_duration(seconds: float | int | None) -> str:
    if seconds is None:
        return "—"
    seconds = max(0, float(seconds))
    if seconds < 1:
        return f"{seconds * 1000:.0f} ms"
    if seconds < 60:
        return f"{seconds:.1f} s"
    minutes, sec = divmod(seconds, 60)
    if minutes < 60:
        return f"{int(minutes)}m {sec:04.1f}s"
    hours, minutes = divmod(minutes, 60)
    return f"{int(hours)}h {int(minutes):02d}m"


def compact_number(value: float | int | None) -> str:
    if value is None:
        return "—"
    n = float(value)
    sign = "-" if n < 0 else ""
    n = abs(n)
    if n >= 1_000_000:
        return f"{sign}{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{sign}{n / 1_000:.1f}k"
    return f"{sign}{int(n)}"


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    xs = sorted(values)
    if len(xs) == 1:
        return xs[0]
    k = (len(xs) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return xs[int(k)]
    return xs[f] * (c - k) + xs[c] * (k - f)


def safe_name(text: str, limit: int = 80) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", text.strip()).strip("-._")
    return (text or "item")[:limit]


def intervals_union_seconds(intervals: Iterable[tuple[datetime, datetime]]) -> float:
    xs = sorted((a, b) for a, b in intervals if a and b and b > a)
    if not xs:
        return 0.0
    total = 0.0
    cur_a, cur_b = xs[0]
    for a, b in xs[1:]:
        if a <= cur_b:
            if b > cur_b:
                cur_b = b
        else:
            total += (cur_b - cur_a).total_seconds()
            cur_a, cur_b = a, b
    total += (cur_b - cur_a).total_seconds()
    return total


def escape_md(text: str) -> str:
    return text.replace("`", "\\`")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                out.append({
                    "type": "_parse_error",
                    "line": line_no,
                    "error": str(exc),
                    "raw": line,
                })
                continue
            if isinstance(obj, dict):
                obj["_line"] = line_no
                out.append(obj)
    return out
