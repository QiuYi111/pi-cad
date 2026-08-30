from __future__ import annotations

import html
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import plotly.graph_objects as go
from plotly.offline import plot

from .util import compact_number, format_duration, parse_time


_ACTIVITY_LABELS = {
    "cad_workflow": "CAD workflow",
    "cad_commit": "CAD commit",
    "cad_build": "CAD build",
    "cad_probe": "CAD probe",
    "cad_other": "CAD other",
    "subagent_tool": "Subagent",
    "image_tool": "Image attach",
    "image_render": "Image/render",
    "file_inspect": "File inspect",
    "file_read": "File read",
    "file_write": "File write",
    "file_mutation": "File mutate",
    "data_compute": "Data/compute",
    "network": "Network",
    "shell": "Shell",
    "package": "Package",
    "python": "Plain Python",
    "tool:codex_generate_image": "Image gen",
}

# Muted, instrument-style categorical palette (readable on dark + paper light).
_PALETTE = [
    "#d99a4e",  # amber (accent)
    "#6fb3a8",  # seafoam
    "#8ea7d8",  # periwinkle
    "#c98ca5",  # rose
    "#a4b86e",  # olive
    "#d47f6a",  # terracotta
    "#7f9fe0",  # azure
    "#a98fc9",  # lavender
    "#5fc0c9",  # cyan
    "#9aa2b1",  # neutral
]

_ACCENT = "#d99a4e"
_GAP_COLOR = "#55617a"
_ERR_COLOR = "#d97b7b"


def _activity_label(value: str) -> str:
    return _ACTIVITY_LABELS.get(value, value.replace("_", " ").replace("tool:", ""))


def _esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _fig_html(fig: go.Figure, include_js: bool = False) -> str:
    return plot(
        fig,
        include_plotlyjs="inline" if include_js else False,
        output_type="div",
        config={"displayModeBar": False, "responsive": True},
    )


def _base_layout(fig: go.Figure, title: str, height: int = 380) -> go.Figure:
    """Chart chrome tuned for the page theme; canvas transparent so CSS shows through."""
    fig.update_layout(
        title=dict(text=title, x=0.01, xanchor="left", y=0.97, yanchor="top",
                   font=dict(family="ui-monospace, 'Cascadia Code', Consolas, Menlo, monospace", size=13, color="#e6ebf2")),
        height=height,
        margin=dict(l=64, r=24, t=56, b=52),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Inter, 'Segoe UI', ui-sans-serif, system-ui, sans-serif", size=11.5, color="#93a0b4"),
        hovermode="closest",
        legend=dict(orientation="h", yanchor="top", y=-0.16, xanchor="left", x=0, font=dict(size=10.5)),
        hoverlabel=dict(bgcolor="#0d1117", bordercolor="#2b3547", font=dict(color="#e6ebf2", size=11)),
    )
    fig.update_xaxes(showgrid=True, gridcolor="#1b2331", zeroline=False, linecolor="#2b3547", tickcolor="#2b3547")
    fig.update_yaxes(showgrid=True, gridcolor="#1b2331", zeroline=False, linecolor="#2b3547", tickcolor="#2b3547")
    return fig


def _hex_rgba(hex_color: str, alpha: float) -> str:
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r},{g},{b},{alpha:.2f})"


def _activity_colors(metrics: dict[str, Any]) -> dict[str, str]:
    """Raw activity id -> color. Lookup sites must use the RAW id, never the label.
    Past one palette cycle, later batches get lower alpha so colors stay distinguishable."""
    acts: list[str] = [r["activity"] for r in (metrics.get("ipython_activity_stats") or [])]
    for cell in metrics.get("ipython_cells") or []:
        for a in cell.get("activities", []):
            if a not in acts:
                acts.append(a)
    out: dict[str, str] = {}
    n = len(_PALETTE)
    for i, a in enumerate(acts):
        base = _PALETTE[i % n]
        cycle = i // n
        out[a] = base if cycle == 0 else _hex_rgba(base, max(0.38, 0.8 - 0.28 * (cycle - 1)))
    return out


def _context_chart(metrics: dict[str, Any]) -> go.Figure:
    rows = metrics.get("context_series") or []
    fig = go.Figure()
    by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_session[f"{'root' if r['agent_depth'] == 0 else r['session_name']} ({r['session_id'][:6]})"].append(r)
    for i, (label, xs) in enumerate(sorted(by_session.items())):
        fig.add_trace(go.Scatter(
            x=[x["elapsed_s"] / 60 for x in xs],
            y=[x["prompt_tokens"] for x in xs],
            mode="lines+markers",
            line=dict(color=_PALETTE[i % len(_PALETTE)], width=2),
            marker=dict(size=6, line=dict(width=0)),
            name=label,
            customdata=[[x["input"], x["cache_read"], x["cache_write"], x["output"], x["model"]] for x in xs],
            hovertemplate="%{x:.1f} min<br>prompt=%{y:,}<br>input=%{customdata[0]:,}<br>cache read=%{customdata[1]:,}<br>cache write=%{customdata[2]:,}<br>output=%{customdata[3]:,}<br>%{customdata[4]}<extra></extra>",
        ))
    _base_layout(fig, "Prompt load over time")
    fig.update_xaxes(title="Elapsed minutes")
    fig.update_yaxes(title="Prompt tokens")
    return fig


def _usage_chart(metrics: dict[str, Any]) -> go.Figure:
    u = metrics["summary"]["family_usage"]
    labels = ["Input", "Cache read", "Cache write", "Output"]
    values = [u["input"], u["cache_read"], u["cache_write"], u["output"]]
    total = sum(values) or 1
    colors = ["#d99a4e", "#6fb3a8", "#8ea7d8", "#c98ca5"]
    fig = go.Figure(go.Bar(
        x=values[::-1], y=labels[::-1], orientation="h", marker_color=colors[::-1],
        marker_line_width=0,
        text=[f"{v / total:.1%}" for v in values][::-1], textposition="auto",
        hovertemplate="%{y}<br>%{x:,} tokens<extra></extra>",
    ))
    _base_layout(fig, "Token accounting (exact usage)", 300)
    fig.update_xaxes(title="Tokens")
    return fig


def _content_chart(metrics: dict[str, Any]) -> go.Figure:
    items = sorted((metrics.get("content_est_tokens_by_kind") or {}).items(), key=lambda kv: kv[1], reverse=True)
    top, rest = items[:8], items[8:]
    if rest:
        top.append(("other", sum(x[1] for x in rest)))
    fig = go.Figure(go.Bar(
        x=[x[1] for x in top][::-1], y=[x[0] for x in top][::-1], orientation="h",
        marker_color=[_PALETTE[i % len(_PALETTE)] for i in range(len(top))][::-1],
        marker_line_width=0,
        hovertemplate="%{y}<br>≈%{x:,} tokens (estimated)<extra></extra>",
    ))
    _base_layout(fig, "Transcript payload by event kind", max(320, 36 * len(top) + 96))
    fig.update_xaxes(title="Estimated tokens")
    return fig


def _tool_count_chart(metrics: dict[str, Any]) -> go.Figure:
    rows = metrics.get("ipython_activity_stats") or []
    colors = _activity_colors(metrics)
    fig = go.Figure(go.Bar(
        x=[r["cell_count"] for r in rows][::-1],
        y=[_activity_label(r["activity"]) for r in rows][::-1],
        orientation="h",
        marker_color=[colors.get(r["activity"], _ACCENT) for r in rows][::-1],
        marker_line_width=0,
        hovertemplate="%{y}<br>cells=%{x}<extra></extra>",
    ))
    _base_layout(fig, "Observed activities (multi-label)", max(300, 36 * len(rows) + 104))
    fig.update_xaxes(title="Cells")
    return fig


def _tool_payload_chart(metrics: dict[str, Any]) -> go.Figure:
    rows = metrics.get("ipython_cells") or []
    colors = _activity_colors(metrics)
    fig = go.Figure()
    activities = sorted({a for r in rows for a in r.get("activities", [])})
    for activity in activities:
        xs = [r for r in rows if activity in r.get("activities", [])]
        fig.add_trace(go.Scatter(
            x=[r["duration_s"] for r in xs], y=[r["result_est_tokens"] for r in xs],
            mode="markers", name=_activity_label(activity),
            marker={"size": 9, "opacity": 0.8, "color": colors.get(activity, _ACCENT), "line": {"width": 0}},
            customdata=[[r["summary"], r["code_lines"], r["style"], r["confidence"], r["is_error"]] for r in xs],
            hovertemplate="%{customdata[0]}<br>duration=%{x:.2f}s · result≈%{y:,} tok<br>%{customdata[1]} lines · %{customdata[2]} · confidence=%{customdata[3]} · error=%{customdata[4]}<extra></extra>",
        ))
    _base_layout(fig, "IPython cells: duration vs result size", 380)
    fig.update_xaxes(title="Duration (s)")
    fig.update_yaxes(title="Result size (est. tokens)")
    return fig


def _time_chart(metrics: dict[str, Any]) -> go.Figure:
    t = metrics["root_time_breakdown"]
    labels = ["Model gap", "IPython wait", "Unattributed"]
    values = [t["model_response_gap_s"], t["tool_wait_s"], t["other_or_idle_s"]]
    explanations = [
        "Prompt-bearing event → assistant response (inferred from timestamps)",
        "Whole IPython/tool call → result",
        "Not attributable from transcript timestamps",
    ]
    fig = go.Figure(go.Bar(
        x=values, y=labels, orientation="h", text=[format_duration(x) for x in values], textposition="auto",
        marker_color=["#8ea7d8", "#d99a4e", "#454f63"],
        marker_line_width=0,
        customdata=explanations,
        hovertemplate="%{y}: %{x:.2f}s<br>%{customdata}<extra></extra>",
    ))
    _base_layout(fig, "Observed root time", 290)
    fig.update_xaxes(title="Time (s)")
    return fig


def _subagent_chart(metrics: dict[str, Any]) -> go.Figure:
    rows = metrics["sessions"]
    names = ["root" if r["depth"] == 0 else f"agent {i}" for i, r in enumerate(rows)]
    full_names = [r["name"] for r in rows]
    usage = [r["usage"] for r in rows]
    fig = go.Figure()
    fig.add_trace(go.Bar(
        name="Prompt load", y=names, x=[u["input"] + u["cache_read"] + u["cache_write"] for u in usage],
        orientation="h", marker_color="#d99a4e", marker_line_width=0,
        customdata=full_names, hovertemplate="%{customdata}<br>prompt Σ=%{x:,}<extra></extra>",
    ))
    fig.add_trace(go.Bar(
        name="Output", y=names, x=[u["output"] for u in usage],
        orientation="h", marker_color="#6fb3a8", marker_line_width=0,
        customdata=full_names, hovertemplate="%{customdata}<br>output=%{x:,}<extra></extra>",
    ))
    _base_layout(fig, "Agent / subagent token use", max(320, 280 + 14 * len(rows)))
    fig.update_layout(barmode="stack")
    fig.update_xaxes(title="Tokens")
    fig.update_yaxes(title="")
    return fig


def _lane_of(x: dict[str, Any]) -> str:
    return "root" if x["agent_depth"] == 0 else x["session_name"][:34]


def _timeline_chart(metrics: dict[str, Any]) -> go.Figure:
    """Waterfall with ONE bar trace for all cells (per-bar color array) and one for
    model gaps. No per-activity traces, so the legend never explodes; activity
    categories are explained by the HTML legend strip rendered under the panel."""
    calls = [x for x in metrics["tool_calls"] if x["duration_s"] > 0 and x.get("timestamp")]
    contexts = [x for x in metrics["context_series"] if x["response_gap_s"] > 0]
    if not calls and not contexts:
        return _base_layout(go.Figure(), "Execution waterfall (insufficient timestamps)", 300)

    colors = _activity_colors(metrics)
    epoch = datetime.min.replace(tzinfo=timezone.utc)

    def ts(x: dict[str, Any]) -> datetime:
        return parse_time(x.get("timestamp")) or epoch

    lanes: list[str] = []
    for x in sorted(calls + contexts, key=ts):
        lane = _lane_of(x)
        if lane not in lanes:
            lanes.append(lane)

    # Use one origin for both layers. Assistant timestamps mark the end of a
    # response gap, so its observable start is timestamp - response_gap_s.
    starts_s = [ts(x).timestamp() for x in calls]
    starts_s.extend(ts(x).timestamp() - x["response_gap_s"] for x in contexts)
    timeline_start_s = min(starts_s)

    fig = go.Figure()

    bases, durs, ys, cols, hovers = [], [], [], [], []
    for x in sorted(calls, key=ts):
        ip = x.get("ipython") or {}
        activity = ip.get("primary_activity") or x["tool_name"]  # raw id — matches colors dict
        label = _activity_label(activity) if ip else x["tool_name"]
        t = ts(x)
        bases.append((t.timestamp() - timeline_start_s) / 60)
        durs.append(x["duration_s"] / 60)
        ys.append(_lane_of(x))
        cols.append(_ERR_COLOR if x.get("is_error") else colors.get(activity, _ACCENT))
        summary = ip.get("summary") or x["tool_name"]
        err = " · ERROR" if x.get("is_error") else ""
        hovers.append(f"{label}{err}\n{summary}\n{x['duration_s']:.1f}s · result≈{x['result_est_tokens']:,} tok")
    if calls:
        fig.add_trace(go.Bar(
            name="Cell execution", y=ys, x=durs, base=bases, orientation="h",
            marker_color=cols, marker_line_width=0,
            customdata=hovers,
            hovertemplate="%{customdata}<br>start +%{base:.2f}m<extra></extra>",
            showlegend=False,
        ))

    bases, durs, ys, hovers = [], [], [], []
    for x in sorted(contexts, key=ts):
        t = ts(x)
        end_m = (t.timestamp() - timeline_start_s) / 60
        dur_m = x["response_gap_s"] / 60
        bases.append(end_m - dur_m)
        durs.append(dur_m)
        ys.append(_lane_of(x))
        hovers.append(f"model response gap≈{x['response_gap_s']:.1f}s · {x['model']}")
    if contexts:
        bases = [max(0.0, b) for b in bases]
        fig.add_trace(go.Bar(
            name="Model response gap", y=ys, x=durs, base=bases, orientation="h",
            marker_color=_GAP_COLOR, marker_line_width=0,
            customdata=hovers,
            hovertemplate="%{customdata}<br>start +%{base:.2f}m<extra></extra>",
            showlegend=False,
        ))

    _base_layout(fig, "Execution waterfall", max(280, 110 + 52 * len(lanes)))
    fig.update_layout(barmode="overlay", bargap=0.55, showlegend=False)
    fig.update_yaxes(categoryorder="array", categoryarray=list(reversed(lanes)))
    fig.update_xaxes(title="Minutes from first observed event")
    return fig


# ---------------------------------------------------------------- UI helpers


def _kpi(label: str, value: str, sub: str = "", tone: str = "") -> str:
    tone_cls = f" kpi--{tone}" if tone else ""
    sub_html = f"<div class='kpi-sub'>{_esc(sub)}</div>" if sub else ""
    return f"<div class='kpi{tone_cls}'><div class='kpi-label'>{_esc(label)}</div><div class='kpi-value'>{_esc(value)}</div>{sub_html}</div>"


def _hexa(color: str, alpha: float) -> str:
    """Append transparency to a color that may be #rrggbb or already rgba()."""
    if color.startswith(("rgba(", "rgb(")):
        return color
    return _hex_rgba(color, alpha)


def _chip(label: str, color: str | None = None) -> str:
    if color:
        style = (f" style='color:{color};border-color:{_hexa(color, 0.37)};"
                 f"background:{_hexa(color, 0.09)}'")
    else:
        style = ""
    return f"<span class='chip'{style}>{_esc(label)}</span>"


def _legend_chip(label: str, color: str, count: int | None = None) -> str:
    n = f"<span class='lg-n'>×{count}</span>" if count is not None else ""
    return (f"<span class='lg-chip'><span class='lg-swatch' style='background:{color}'></span>"
            f"{_esc(label)}{n}</span>")


def _badge(text: str, variant: str = "") -> str:
    cls = f" badge--{variant}" if variant else ""
    return f"<span class='badge{cls}'>{_esc(text)}</span>"


_CONF_TONE = {"high": "ok", "medium": "warn", "low": "err"}


def _conf_badge(conf: str) -> str:
    return _badge(conf, _CONF_TONE.get(conf, ""))


def _empty(message: str) -> str:
    return f"<div class='empty'>{_esc(message)}</div>"


def _section(num: str, section_id: str, title: str, subtitle: str, body: str) -> str:
    return (
        f"<section id='{section_id}' class='section'>"
        f"<header class='section-head'><h2><span class='sec-no'>{num}</span>{_esc(title)}</h2>"
        f"<p class='section-sub'>{_esc(subtitle)}</p></header>"
        f"{body}</section>"
    )


def _panel(fig_html: str, extra_cls: str = "") -> str:
    return f"<div class='panel {extra_cls}'>{fig_html}</div>"


def _table_html(
    headers: list[str],
    rows: list[list[Any]],
    *,
    limit: int | None = None,
    aligns: list[str] | None = None,
    table_id: str = "",
    scroll: bool = False,
) -> str:
    """Render a table. Cells may be plain text (escaped) or (html, sort_value) tuples."""
    if not rows:
        return ""
    if limit is not None:
        rows = rows[:limit]
    aligns = aligns or ["l"] * len(headers)
    ths = "".join(
        f"<th data-align='{a}'>{_esc(h)}</th>" for h, a in zip(headers, aligns)
    )
    trs = []
    for row in rows:
        tds = []
        for cell, align in zip(row, aligns):
            if isinstance(cell, tuple):
                content, sort_value = cell
                tds.append(f"<td data-align='{align}' data-sort='{_esc(sort_value)}'>{content}</td>")
            else:
                tds.append(f"<td data-align='{align}'>{_esc(cell)}</td>")
        trs.append(f"<tr>{''.join(tds)}</tr>")
    id_attr = f" id='{table_id}'" if table_id else ""
    scroll_cls = " table-wrap--scroll" if scroll else ""
    return (
        f"<div class='table-wrap{scroll_cls}'>"
        f"<table{id_attr} data-sortable='1'><thead><tr>{ths}</tr></thead><tbody>{''.join(trs)}</tbody></table>"
        f"</div>"
    )


def _fmt_time_short(timestamp: Any) -> str:
    t = parse_time(timestamp)
    if not t:
        return "—"
    return t.strftime("%H:%M:%S")


_CSS = r"""
:root{
  --bg:#0b0f15;--bg-soft:#0d1219;--panel:#10161f;--panel-2:#151d29;
  --border:#1e2735;--border-soft:#182030;
  --text:#e6ebf2;--muted:#93a0b4;--faint:#5f6b80;
  --accent:#d99a4e;--accent-soft:#d99a4e1c;
  --ok:#7fb069;--warn:#e0b458;--err:#d97b7b;--violet:#8ea7d8;
  --mono:ui-monospace,'SF Mono','Cascadia Code',Consolas,Menlo,monospace;
  --shadow:0 10px 34px rgba(0,0,0,.4);
  color-scheme:dark;
}
[data-theme="light"]{
  --bg:#f4f1e9;--bg-soft:#efeadf;--panel:#fffdf8;--panel-2:#f5f1e6;
  --border:#ddd5c3;--border-soft:#e8e2d3;
  --text:#241e12;--muted:#5d564a;--faint:#8b8272;
  --accent:#9c651a;--accent-soft:#9c651a14;
  --ok:#4c7a3f;--warn:#8f6410;--err:#a83a3a;--violet:#4a5fa5;
  --shadow:0 8px 26px rgba(74,62,38,.12);
  color-scheme:light;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;color:var(--text);
  background:
    radial-gradient(1100px 420px at 78% -12%, rgba(217,154,78,.055), transparent 62%),
    var(--bg);
  font:14px/1.55 Inter,'Segoe UI',ui-sans-serif,system-ui,-apple-system,sans-serif;
  display:flex;min-height:100vh}
[data-theme="light"] body{background:
    radial-gradient(1100px 420px at 78% -12%, rgba(156,101,26,.05), transparent 62%),
    var(--bg)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
::selection{background:var(--accent);color:#14100a}
a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* ---------- sidebar ---------- */
.sidebar{width:232px;flex:0 0 232px;position:sticky;top:0;height:100vh;overflow-y:auto;
  background:var(--bg-soft);border-right:1px solid var(--border);padding:18px 12px;display:flex;flex-direction:column;gap:16px;z-index:40}
.brand{display:flex;align-items:center;gap:10px;padding:2px 8px}
.brand-mark{width:30px;height:30px;border-radius:5px;flex:none;display:grid;place-items:center;
  background:var(--panel-2);border:1px solid var(--border);color:var(--accent);
  font-family:var(--mono);font-weight:700;font-size:12px}
.brand-name{font-family:var(--mono);font-weight:700;font-size:12.5px;line-height:1.25;letter-spacing:.02em}
.brand-sub{font-family:var(--mono);font-size:10px;color:var(--faint);letter-spacing:.08em;text-transform:uppercase}
.nav{display:flex;flex-direction:column;gap:1px}
.nav-title{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:6px 10px 4px}
.nav a{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:4px;color:var(--muted);
  font-family:var(--mono);font-size:12px;border-left:2px solid transparent}
.nav a:hover{background:var(--panel-2);color:var(--text);text-decoration:none}
.nav a.active{background:var(--accent-soft);color:var(--accent);border-left-color:var(--accent);font-weight:600}
.nav a .no{color:var(--faint);font-size:10px;width:16px;flex:none}
.nav a.active .no{color:var(--accent)}
.side-files{margin-top:auto;display:flex;flex-direction:column;gap:1px;border-top:1px solid var(--border);padding-top:12px}
.side-files a{font-size:11px;padding:5px 10px;border-radius:4px;color:var(--muted);font-family:var(--mono)}
.side-files a:hover{background:var(--panel-2);color:var(--text);text-decoration:none}
.theme-note{font-family:var(--mono);font-size:10px;color:var(--faint);padding:0 10px;letter-spacing:.04em}

/* ---------- main column ---------- */
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:12px;
  padding:10px 26px;background:var(--bg);border-bottom:1px solid var(--border);
  box-shadow:inset 0 -1px 0 var(--accent-soft)}
.topbar .crumb{font-family:var(--mono);font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar .crumb b{color:var(--text);font-weight:600}
.topbar-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);background:var(--panel);
  color:var(--muted);border-radius:5px;padding:6px 11px;font-family:var(--mono);font-size:11.5px;cursor:pointer}
.btn:hover{color:var(--text);border-color:var(--faint);text-decoration:none}
.icon-btn{padding:6px 9px}
.hamburger{display:none}
.content{padding:26px 28px 40px;max-width:1460px;width:100%;margin:0 auto}

/* ---------- hero ---------- */
.hero h1{font-family:var(--mono);font-size:17px;font-weight:600;letter-spacing:.06em;
  text-transform:uppercase;margin:0 0 8px}
.hero h1 .tick{color:var(--accent);margin-right:8px}
.hero-meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin:10px 0 4px;color:var(--muted);font-size:12.5px;font-family:var(--mono)}
.hero-meta .item{display:inline-flex;align-items:center;gap:6px}
.hero-meta .item b{color:var(--text);font-weight:600}
.session-chip{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11.5px;
  background:var(--panel);border:1px solid var(--border);border-radius:5px;padding:4px 6px 4px 10px;color:var(--muted)}
.session-chip button{border:0;background:transparent;color:var(--faint);cursor:pointer;font-family:var(--mono);font-size:10.5px;padding:2px 5px;border-radius:3px}
.session-chip button:hover{background:var(--panel-2);color:var(--text)}

/* ---------- sections ---------- */
.section{margin:36px 0;scroll-margin-top:70px}
.section-head{margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.section-head h2{font-size:15px;margin:0;letter-spacing:.02em;display:flex;align-items:baseline;gap:10px;font-weight:650}
.section-head .sec-no{font-family:var(--mono);color:var(--accent);font-size:11px;letter-spacing:.1em}
.section-sub{margin:4px 0 0 0;color:var(--muted);font-size:12.5px;max-width:840px}

.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:10px;margin:18px 0 6px}
.kpi{background:var(--panel);border:1px solid var(--border);border-top:2px solid var(--faint);border-radius:6px;padding:12px 14px}
.kpi-label{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
.kpi-value{font-family:var(--mono);font-size:22px;font-weight:600;margin-top:5px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.kpi-sub{font-size:11px;color:var(--faint);margin-top:2px}
.kpi--ok{border-top-color:var(--ok)} .kpi--ok .kpi-value{color:var(--ok)}
.kpi--warn{border-top-color:var(--warn)} .kpi--warn .kpi-value{color:var(--warn)}
.kpi--err{border-top-color:var(--err)} .kpi--err .kpi-value{color:var(--err)}
.kpi--violet{border-top-color:var(--violet)} .kpi--violet .kpi-value{color:var(--violet)}

.callout{background:var(--panel);border:1px solid var(--border);border-left:2px solid var(--warn);
  border-radius:6px;padding:12px 15px;margin:16px 0;color:var(--muted);font-size:12.5px}
.callout b{color:var(--text)}
.callout ul{margin:8px 0 0;padding-left:18px}
.callout li{margin:2px 0}

.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.grid2.cols-58{grid-template-columns:minmax(0,1.38fr) minmax(0,1fr)}
.span-2{grid-column:1/-1}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:6px}
.panel .js-plotly-plot{width:100%}

/* timeline HTML legend strip */
.lg-strip{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
.lg-chip{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;
  color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:3px 9px;background:var(--panel)}
.lg-swatch{width:9px;height:9px;border-radius:2px;flex:none}
.lg-n{color:var(--faint)}

/* ---------- tables ---------- */
.table-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.table-toolbar input{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:5px;
  padding:7px 11px;font-size:12.5px;font-family:inherit;width:280px;max-width:100%}
.table-toolbar input::placeholder{color:var(--faint)}
.table-count{font-family:var(--mono);font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}
.table-wrap{background:var(--panel);border:1px solid var(--border);border-radius:6px;overflow:hidden}
.table-wrap--scroll{max-height:600px;overflow-y:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px}
thead th{position:sticky;top:0;z-index:2;background:var(--panel-2);color:var(--faint);
  font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;text-align:left;
  padding:9px 13px;border-bottom:1px solid var(--border);white-space:nowrap;user-select:none}
table[data-sortable] thead th{cursor:pointer}
table[data-sortable] thead th:hover{color:var(--text)}
thead th[data-sortdir="asc"]::after{content:" ↑";color:var(--accent)}
thead th[data-sortdir="desc"]::after{content:" ↓";color:var(--accent)}
tbody td{padding:8px 13px;border-bottom:1px solid var(--border-soft);vertical-align:top;max-width:640px}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--panel-2)}
td[data-align="r"],th[data-align="r"]{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td[data-align="m"]{font-family:var(--mono);font-size:11.5px;white-space:nowrap;color:var(--muted)}
tbody tr.row-err td{background:color-mix(in srgb,var(--err) 8%,transparent)}
.mono{font-family:var(--mono);font-size:12px}
.indent{color:var(--faint);margin-right:2px}
.truncate{display:inline-block;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}

.chip{display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:3px;
  padding:1px 7px;font-family:var(--mono);font-size:10.5px;color:var(--muted);margin:1px 2px 1px 0;
  white-space:nowrap;background:var(--panel-2);letter-spacing:.02em}
.badge{display:inline-flex;align-items:center;border-radius:3px;padding:1px 6px;font-family:var(--mono);
  font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;border:1px solid transparent}
.badge--ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent);border-color:color-mix(in srgb,var(--ok) 32%,transparent)}
.badge--warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent);border-color:color-mix(in srgb,var(--warn) 32%,transparent)}
.badge--err{color:var(--err);background:color-mix(in srgb,var(--err) 12%,transparent);border-color:color-mix(in srgb,var(--err) 32%,transparent)}
.badge--dim{color:var(--muted);background:var(--panel-2);border-color:var(--border)}

.empty{border:1px dashed var(--border);border-radius:6px;padding:26px;text-align:center;color:var(--faint);
  font-family:var(--mono);font-size:12px;background:var(--panel)}

footer{margin-top:auto;padding:16px 28px;border-top:1px solid var(--border);color:var(--faint);
  font-family:var(--mono);font-size:11px;display:flex;gap:16px;flex-wrap:wrap}

.scrim{display:none}
@media (max-width:960px){
  .sidebar{position:fixed;left:0;top:0;transform:translateX(-100%);transition:transform .2s ease;box-shadow:var(--shadow)}
  body.nav-open .sidebar{transform:none}
  body.nav-open .scrim{display:block;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:35}
  .hamburger{display:inline-flex}
  .content{padding:18px 16px 32px}
  .topbar{padding:10px 16px}
  .grid2,.grid2.cols-58{grid-template-columns:1fr}
  .kpi-value{font-size:19px}
  .hero h1{font-size:14px}
}
@media print{.sidebar,.topbar-actions,.hamburger{display:none!important}body{display:block}}
"""


_JS = r"""
(function () {
  'use strict';
  var THEMES = {};
  var themeEl = document.getElementById('ptl-theme-patch');
  if (themeEl) { try { THEMES = JSON.parse(themeEl.textContent); } catch (e) {} }

  /* ---- theme toggle ---- */
  var root = document.documentElement;
  var toggle = document.getElementById('themeToggle');
  var ICONS = { dark: '☾', light: '☀' };

  function chartPatch(t) {
    return {
      'font.color': t.font,
      'title.font.color': t.title,
      'legend.font.color': t.font,
      'hoverlabel.bgcolor': t.hoverBg,
      'hoverlabel.bordercolor': t.hoverBorder,
      'hoverlabel.font.color': t.hoverFg,
      'paper_bgcolor': 'rgba(0,0,0,0)',
      'plot_bgcolor': 'rgba(0,0,0,0)'
    };
  }
  function axisPatch(prefix, t) {
    var p = {};
    p[prefix + '.gridcolor'] = t.grid;
    p[prefix + '.linecolor'] = t.line;
    p[prefix + '.tickcolor'] = t.tick;
    p[prefix + '.tickfont.color'] = t.font;
    p[prefix + '.title.font.color'] = t.font;
    return p;
  }
  function applyCharts(name) {
    var t = THEMES[name];
    if (!t || !window.Plotly) return;
    document.querySelectorAll('.js-plotly-plot').forEach(function (gd) {
      if (!gd.data) return;
      var patch = Object.assign(chartPatch(t), axisPatch('xaxis', t), axisPatch('yaxis', t));
      try { window.Plotly.relayout(gd, patch); } catch (e) {}
    });
  }
  function setTheme(name, persist) {
    root.setAttribute('data-theme', name);
    if (toggle) toggle.textContent = ICONS[name] || '☾';
    applyCharts(name);
    if (persist) { try { localStorage.setItem('ptl-theme', name); } catch (e) {} }
  }
  var saved = null;
  try { saved = localStorage.getItem('ptl-theme'); } catch (e) {}
  setTheme(saved === 'light' || saved === 'dark' ? saved : 'dark', false);
  if (toggle) toggle.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(next, true);
  });

  /* ---- sidebar / mobile nav ---- */
  var burger = document.getElementById('navToggle');
  var scrim = document.getElementById('scrim');
  function closeNav() { document.body.classList.remove('nav-open'); }
  if (burger) burger.addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
  if (scrim) scrim.addEventListener('click', closeNav);
  document.querySelectorAll('.nav a').forEach(function (a) { a.addEventListener('click', closeNav); });

  /* ---- scrollspy ---- */
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav a[href^="#"]'));
  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  var sections = Array.prototype.slice.call(document.querySelectorAll('section.section'));
  if ('IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting && byId[en.target.id]) {
          links.forEach(function (a) { a.classList.remove('active'); });
          byId[en.target.id].classList.add('active');
        }
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    sections.forEach(function (s) { spy.observe(s); });
  }

  /* ---- sortable tables ---- */
  document.querySelectorAll('table[data-sortable]').forEach(function (table) {
    var ths = table.querySelectorAll('thead th');
    Array.prototype.forEach.call(ths, function (th, idx) {
      th.addEventListener('click', function () {
        var tbody = table.querySelector('tbody');
        var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
        var dir = th.getAttribute('data-sortdir') === 'asc' ? 'desc' : 'asc';
        Array.prototype.forEach.call(ths, function (h) { h.removeAttribute('data-sortdir'); });
        th.setAttribute('data-sortdir', dir);
        rows.sort(function (ra, rb) {
          var da = ra.children[idx] ? ra.children[idx].getAttribute('data-sort') : null;
          var db = rb.children[idx] ? rb.children[idx].getAttribute('data-sort') : null;
          var va, vb;
          if (da !== null && da !== '' && db !== null && db !== '') {
            var na = parseFloat(da), nb = parseFloat(db);
            if (!isNaN(na) && !isNaN(nb)) { va = na; vb = nb; }
          }
          if (va === undefined) {
            va = (ra.children[idx] ? ra.children[idx].textContent : '').trim();
            vb = (rb.children[idx] ? rb.children[idx].textContent : '').trim();
            return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          }
          return dir === 'asc' ? va - vb : vb - va;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      });
    });
  });

  /* ---- cells filter ---- */
  var filter = document.getElementById('cellsFilter');
  var cellsTable = document.getElementById('cellsTable');
  var countEl = document.getElementById('cellsCount');
  if (filter && cellsTable) {
    filter.addEventListener('input', function () {
      var q = filter.value.trim().toLowerCase();
      var shown = 0;
      var all = cellsTable.querySelectorAll('tbody tr');
      all.forEach(function (tr) {
        var hit = !q || tr.textContent.toLowerCase().indexOf(q) !== -1;
        tr.style.display = hit ? '' : 'none';
        if (hit) shown++;
      });
      if (countEl) countEl.textContent = shown + ' / ' + all.length + ' cells';
    });
  }

  /* ---- copy session id ---- */
  var copyBtn = document.getElementById('copySession');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    var text = copyBtn.getAttribute('data-value') || '';
    function done(ok) { copyBtn.textContent = ok ? 'copied ✓' : 'failed'; setTimeout(function () { copyBtn.textContent = 'copy'; }, 1400); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else { done(false); }
  });
})();
"""


def write_report(metrics: dict[str, Any], out_path: Path) -> None:
    s = metrics["summary"]
    u = s["family_usage"]
    has_cells = bool(metrics.get("ipython_cells"))
    activity_colors = _activity_colors(metrics)

    # ---- KPI cards ------------------------------------------------
    root_wall = s.get("root_wall_time_s") or 0.0
    wall_sub = f"root {format_duration(root_wall)}" if abs(s["wall_time_s"] - root_wall) > 0.5 else "root + subagents"
    cards = [
        _kpi("Wall time", format_duration(s["wall_time_s"]), wall_sub),
        _kpi("Prompt load Σ", compact_number(u["input"] + u["cache_read"] + u["cache_write"]), "input + cache r/w"),
        _kpi("Output tokens", compact_number(u["output"]), "assistant output"),
        _kpi("Peak prompt", compact_number(s["prompt_peak_tokens"]), "max prompt_tokens", "violet"),
        _kpi("IPython cells" if has_cells else "Tool calls", str(len(metrics.get("ipython_cells") or [])) if has_cells else str(s["tool_calls"]), "evidence-classified" if has_cells else "outer tool calls"),
        _kpi("Subagents", str(s["subagent_count"]), f"{s['session_count']} sessions total"),
        _kpi("Tool errors", str(s["tool_errors"]), "failed results", "err" if s["tool_errors"] else "ok"),
        _kpi("Compactions", str(s["compactions"]), "context compactions", "warn" if s["compactions"] else ""),
    ]

    # ---- figures ---------------------------------------------------
    usage_fig = _usage_chart(metrics)
    time_fig = _time_chart(metrics)
    context_fig = _context_chart(metrics)
    timeline_fig = _timeline_chart(metrics)
    content_fig = _content_chart(metrics)
    count_fig = _tool_count_chart(metrics)
    payload_fig = _tool_payload_chart(metrics)

    figs_in_order = [usage_fig, time_fig, context_fig, timeline_fig, content_fig, count_fig, payload_fig]
    subagent_fig = None
    if len(metrics["sessions"]) > 1:
        subagent_fig = _subagent_chart(metrics)
        figs_in_order.append(subagent_fig)

    rendered: dict[int, str] = {}
    for i, fig in enumerate(figs_in_order):
        rendered[id(fig)] = _fig_html(fig, include_js=(i == 0))

    # ---- notes callout ---------------------------------------------
    notes_items = "".join(f"<li><b>{_esc(k)}</b>: {_esc(v)}</li>" for k, v in (metrics.get("notes") or {}).items())
    callout = (
        "<div class='callout'><b>How to read this report.</b> "
        "API token counts are exact Prime usage fields. IPython activities are evidence-based static "
        "classifications, may be multi-label, and do not recover timing inside a cell. "
        "\u201cUnattributed\u201d time means the transcript cannot assign that interval — not that the agent was idle."
        f"<ul>{notes_items}</ul></div>"
    )

    # ---- overview ---------------------------------------------------
    overview_body = (
        f"<div class='kpis'>{''.join(cards)}</div>{callout}"
        f"<div class='grid2' style='margin-top:14px'>{_panel(rendered[id(usage_fig)])}{_panel(rendered[id(time_fig)])}</div>"
    )

    # ---- context ----------------------------------------------------
    context_body = f"<div class='grid2 cols-58'>{_panel(rendered[id(context_fig)], 'span-2')}{_panel(rendered[id(content_fig)])}</div>"

    # ---- timeline (chart + HTML legend strip) ------------------------
    act_counts: Counter[str] = Counter()
    for c in metrics["tool_calls"]:
        ip = c.get("ipython") or {}
        act_counts[str(ip.get("primary_activity") or c["tool_name"])] += 1
    gap_count = sum(1 for x in metrics["context_series"] if x["response_gap_s"] > 0)
    err_count = sum(1 for c in metrics["tool_calls"] if c.get("is_error"))
    lg_chips = [_legend_chip(_activity_label(a), activity_colors.get(a, _ACCENT), n) for a, n in act_counts.most_common()]
    if gap_count:
        lg_chips.append(_legend_chip("model response gap", _GAP_COLOR, gap_count))
    if err_count:
        lg_chips.append(_legend_chip("error cell", _ERR_COLOR, err_count))
    legend_html = f"<div class='lg-strip'>{''.join(lg_chips)}</div>" if lg_chips else ""
    timeline_body = _panel(rendered[id(timeline_fig)]) + legend_html

    # ---- activities -------------------------------------------------
    activities_body = f"<div class='grid2'>{_panel(rendered[id(count_fig)])}{_panel(rendered[id(payload_fig)])}</div>"

    # ---- agents table ----------------------------------------------
    session_rows = []
    for i, r in enumerate(metrics["sessions"]):
        ru = r["usage"]
        prefix = "root" if r["depth"] == 0 else f"<span class='indent'>{'↳' * r['depth']}</span> agent {i}"
        name = _esc(r["name"])
        session_rows.append([
            f"<span class='truncate' title='{name}'>{prefix} · {name}</span>",
            (r["session_id"][:8], r["session_id"][:8]),
            (format_duration(r["duration_s"]), f"{r['duration_s']:012.2f}"),
            (str(r["assistant_calls"]), f"{r['assistant_calls']:08d}"),
            (str(r["tool_calls"]), f"{r['tool_calls']:08d}"),
            (str(r["tool_errors"]), f"{r['tool_errors']:08d}"),
            (str(r["compactions"]), f"{r['compactions']:08d}"),
            (compact_number(ru["input"] + ru["cache_read"] + ru["cache_write"]), str(ru["input"] + ru["cache_read"] + ru["cache_write"])),
            (compact_number(ru["output"]), str(ru["output"])),
        ])
    agents_table = _table_html(
        ["Agent", "Session", "Duration", "Model calls", "Tools", "Errors", "Compactions", "Prompt Σ", "Output"],
        session_rows,
        aligns=["l", "m", "r", "r", "r", "r", "r", "r", "r"],
    )
    agents_body = ""
    if subagent_fig is not None:
        agents_body += _panel(rendered[id(subagent_fig)]) + "<div style='height:12px'></div>"
    agents_body += agents_table or _empty("No sessions recorded.")

    # ---- cells table -------------------------------------------------
    cells = sorted(metrics.get("ipython_cells") or [], key=lambda x: x.get("timestamp") or "")
    cell_rows = []
    for i, r in enumerate(cells):
        chips = " ".join(_chip(_activity_label(a), activity_colors.get(a)) for a in r.get("activities", []))
        summary = _esc(r.get("summary") or "")
        err_cls = " class='row-err'" if r.get("is_error") else ""
        cell_rows.append((
            err_cls,
            [
                (str(i + 1), f"{i + 1:08d}"),
                (_fmt_time_short(r.get("timestamp")), _esc(r.get("timestamp") or "")),
                chips or _badge("—", "dim"),
                _badge(r.get("style") or "—", "dim"),
                _conf_badge(r.get("confidence") or "—"),
                (summary, summary),
                (format_duration(r["duration_s"]), f"{r['duration_s']:012.2f}"),
                (compact_number(r["result_est_tokens"]), str(r["result_est_tokens"])),
                _badge("error", "err") if r.get("is_error") else "",
            ],
        ))
    cell_table = ""
    if cell_rows:
        trs = []
        for err_cls, row in cell_rows:
            tds = []
            for cell, align in zip(row, ["r", "m", "l", "l", "l", "l", "r", "r", "l"]):
                if isinstance(cell, tuple):
                    content, sort_value = cell
                    tds.append(f"<td data-align='{align}' data-sort='{_esc(sort_value)}'>{content}</td>")
                else:
                    tds.append(f"<td data-align='{align}'>{cell}</td>")
            trs.append(f"<tr{err_cls}>{''.join(tds)}</tr>")
        ths = "".join(
            f"<th data-align='{a}'>{_esc(h)}</th>"
            for h, a in zip(["#", "Start", "Activities", "Style", "Confidence", "Evidence summary", "Duration", "Result ≈tok", "Status"],
                            ["r", "m", "l", "l", "l", "l", "r", "r", "l"])
        )
        cell_table = (
            "<div class='table-toolbar'>"
            "<input id='cellsFilter' type='search' placeholder='Filter cells — activity, summary, style…' aria-label='Filter cells'>"
            f"<span class='table-count' id='cellsCount'>{len(cell_rows)} cells</span>"
            "</div>"
            "<div class='table-wrap table-wrap--scroll'>"
            f"<table id='cellsTable' data-sortable='1'><thead><tr>{ths}</tr></thead><tbody>{''.join(trs)}</tbody></table>"
            "</div>"
        )
    cells_body = cell_table or _empty("No IPython cells found.")

    # ---- known tool wrappers ----------------------------------------
    known_rows = [[(_esc(r["tool"]), r["tool"]), (str(r["call_count"]), f"{r['call_count']:08d}")] for r in metrics.get("known_tool_stats") or []]
    wrappers_body = _table_html(["Tool wrapper", "Calls"], known_rows, aligns=["l", "r"]) or _empty("No known tool wrappers detected.")

    # ---- longest calls ------------------------------------------------
    longest_rows = []
    for r in metrics["longest_tools"]:
        summary = _esc((r.get("ipython") or {}).get("summary") or r["tool_name"])
        longest_rows.append([
            (summary, summary),
            f"<span class='truncate'>{_esc(r['session_name'])}</span>",
            (_fmt_time_short(r.get("timestamp")), _esc(r.get("timestamp") or "")),
            (format_duration(r["duration_s"]), f"{r['duration_s']:012.2f}"),
            (compact_number(r["result_est_tokens"]), str(r["result_est_tokens"])),
            _badge("error", "err") if r.get("is_error") else _badge("ok", "ok"),
        ])
    longest_body = _table_html(
        ["Observed activity", "Agent", "Start", "Duration", "Result ≈tok", "Status"],
        longest_rows, limit=25, aligns=["l", "l", "m", "r", "r", "l"], scroll=True,
    ) or _empty("No timed tool calls recorded.")

    # ---- repeated calls ------------------------------------------------
    repeated_rows = []
    for r in metrics["repeated_calls"]:
        args = _esc(r["arguments"])
        repeated_rows.append([(_esc(r["tool_name"]), r["tool_name"]), (str(r["count"]), f"{r['count']:08d}"), f"<span class='mono truncate'>{args}</span>"])
    repeated_body = _table_html(["Outer tool", "Count", "Arguments (truncated)"], repeated_rows, limit=30, aligns=["l", "r", "l"]) or _empty("No repeated identical calls detected.")

    # ---- hero meta -----------------------------------------------------
    starts = [parse_time(r.get("start")) for r in metrics["sessions"]]
    ends = [parse_time(r.get("end")) for r in metrics["sessions"]]
    starts = [t for t in starts if t]
    ends = [t for t in ends if t]
    window = "—"
    if starts and ends:
        lo, hi = min(starts), max(ends)
        day = f"{lo:%Y-%m-%d} "
        window = f"{day}{lo:%H:%M:%S} → " + (f"{hi:%H:%M:%S}" if hi.date() == lo.date() else f"{hi:%Y-%m-%d %H:%M:%S}") + " UTC"
    models = " · ".join(f"{_esc(m)} ×{n}" for m, n in sorted((s.get("models") or {}).items())) or "—"
    cost = s["family_usage"].get("cost") or 0.0
    root_path = str(metrics.get("root_path") or "")
    root_id = str(metrics.get("root_session_id") or "")

    hero = f"""
    <div class="hero">
      <h1><span class="tick">//</span>Prime transcript forensic report</h1>
      <div class="session-chip"><span>session</span><span class="mono">{_esc(root_id)}</span><button id="copySession" data-value="{_esc(root_id)}" title="Copy session id">copy</button></div>
      <div class="hero-meta">
        <span class="item">🕕 <b>{_esc(window)}</b></span>
        <span class="item">🤖 <b>{models}</b></span>
        <span class="item">💸 <b>{f"${cost:.2f}" if cost else "—"}</b> est. spend</span>
        <span class="item">📄 <b>{s['assistant_calls']}</b> model calls</span>
        <span class="item" title="{_esc(root_path)}">🗂 <b>{_esc(Path(root_path).name if root_path else '—')}</b></span>
      </div>
    </div>"""

    nav_entries = [
        ("overview", "Overview"),
        ("context", "Context & tokens"),
        ("timeline", "Timeline"),
        ("activities", "Activities"),
        ("agents", "Agents"),
        ("cells", "IPython cells"),
        ("wrappers", "Tool wrappers"),
        ("longest", "Longest calls"),
        ("repeated", "Repeated calls"),
    ]
    nav_links = "".join(
        f"<a href='#{sid}'><span class='no'>{i + 1:02d}</span>{_esc(t)}</a>" for i, (sid, t) in enumerate(nav_entries)
    )

    theme_patch = {
        "dark": {"font": "#93a0b4", "title": "#e6ebf2", "grid": "#1b2331", "line": "#2b3547", "tick": "#2b3547",
                  "hoverBg": "#0d1117", "hoverBorder": "#2b3547", "hoverFg": "#e6ebf2"},
        "light": {"font": "#5d564a", "title": "#241e12", "grid": "#e7e1d2", "line": "#cfc6b2", "tick": "#cfc6b2",
                   "hoverBg": "#241e12", "hoverBorder": "#241e12", "hoverFg": "#f4f1e9"},
    }

    doc = f"""<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Prime trace report · {_esc(root_id[:24])}</title>
<style>{_CSS}</style>
</head>
<body>
<aside class="sidebar">
  <div class="brand">
    <div class="brand-mark">&gt;_</div>
    <div><div class="brand-name">prime-transcript-lab</div><div class="brand-sub">forensic report</div></div>
  </div>
  <nav class="nav" aria-label="Sections">
    <div class="nav-title">Report</div>
    {nav_links}
  </nav>
  <div class="side-files">
    <div class="nav-title">Raw outputs</div>
    <a href="transcript.md">transcript.md</a>
    <a href="metrics.json">metrics.json</a>
    <a href="events.jsonl">events.jsonl</a>
    <div class="theme-note">self-contained html · charts embedded</div>
  </div>
</aside>
<div class="scrim" id="scrim"></div>
<div class="main">
  <div class="topbar">
    <button class="btn icon-btn hamburger" id="navToggle" aria-label="Toggle navigation">☰</button>
    <span class="crumb"><b>prime trace</b> · session {_esc(root_id[:16])}…</span>
    <div class="topbar-actions">
      <a class="btn" href="transcript.md">transcript.md</a>
      <a class="btn" href="metrics.json">metrics.json</a>
      <button class="btn icon-btn" id="themeToggle" aria-label="Toggle theme" title="Toggle light / dark">☾</button>
    </div>
  </div>
  <div class="content">
    {hero}
    {_section("01", "overview", "Overview", "Session-wide key figures, exact token accounting, and how root wall time splits between model gaps and tool waits.", overview_body)}
    {_section("02", "context", "Context & tokens", "Prompt load per assistant call (exact usage fields) and estimated payload attribution by event kind.", context_body)}
    {_section("03", "timeline", "Timeline", "Execution waterfall: cell executions and inferred model response gaps per agent lane. Bar color = primary activity; legend below the chart.", timeline_body)}
    {_section("04", "activities", "Activities", "Evidence-based multi-label classification of IPython cells; duration vs result size per activity.", activities_body)}
    {_section("05", "agents", "Agents", "Per-session usage, call counts, errors, and compactions for the root session and discovered subagents.", agents_body)}
    {_section("06", "cells", "IPython cells", "Every observed cell with its classification evidence. Filter, or click a column header to sort.", cells_body)}
    {_section("07", "wrappers", "Tool wrappers", "Inner tools detected inside IPython cells (evidence-based).", wrappers_body)}
    {_section("08", "longest", "Longest calls", "Top 25 slowest observed calls by wall duration.", longest_body)}
    {_section("09", "repeated", "Repeated calls", "Identical outer-tool invocations repeated with the same arguments — potential retry loops.", repeated_body)}
  </div>
  <footer>
    <span>prime-transcript-lab · schema v{metrics.get('schema_version', '?')}</span>
    <span>{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}</span>
    <span>token counts from prime usage fields; “≈” marks estimates</span>
  </footer>
</div>
<script id="ptl-theme-patch" type="application/json">{json.dumps(theme_patch)}</script>
<script>{_JS}</script>
</body>
</html>"""
    out_path.write_text(doc, encoding="utf-8")
