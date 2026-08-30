from __future__ import annotations

import json
from pathlib import Path

import pytest

from prime_trace.export_md import write_markdown
from prime_trace.metrics import build_metrics
from prime_trace.parser import load_trace, write_events
from prime_trace.report import _timeline_chart, write_report
from prime_trace.ipython_ops import analyze_ipython


def test_sample(tmp_path: Path) -> None:
    here = Path(__file__).resolve().parents[1]
    root = here / "examples" / "root.jsonl"
    bundle = load_trace(root, scan_dir=here / "examples")
    metrics = build_metrics(bundle)
    assert metrics["summary"]["session_count"] == 2
    assert metrics["summary"]["subagent_count"] == 1
    assert metrics["summary"]["tool_calls"] == 1
    assert metrics["summary"]["prompt_peak_tokens"] == 2200
    assert metrics["sessions"][1]["name"] == "geometry-scout"
    assert metrics["schema_version"] == 2
    assert metrics["ipython_cells"][0]["activities"] == ["file_read"]
    assert "read_text" in metrics["ipython_cells"][0]["summary"]

    timeline = _timeline_chart(metrics)
    cell_trace, model_trace = timeline.data
    assert cell_trace.base[0] == pytest.approx(4 / 60)
    assert min(model_trace.base) == pytest.approx(0)
    assert cell_trace.hovertemplate.startswith("%{customdata}<br>")

    write_events(bundle, tmp_path / "events.jsonl")
    (tmp_path / "metrics.json").write_text(json.dumps(metrics), encoding="utf-8")
    write_markdown(bundle, metrics, tmp_path, inline_limit=500)
    write_report(metrics, tmp_path / "report.html")
    for name in ["events.jsonl", "metrics.json", "transcript.md", "report.html"]:
        assert (tmp_path / name).exists()
        assert (tmp_path / name).stat().st_size > 0

    report = (tmp_path / "report.html").read_text(encoding="utf-8")
    assert "Observed activities" in report
    assert "Largest tool results" not in report


def test_ipython_activity_classifier() -> None:
    mixed = analyze_ipython({"code": """from pathlib import Path
text = Path('input.txt').read_text()
import requests
r = requests.get('https://example.test/data')
Path('output.txt').write_text(r.text)
"""})
    assert mixed["activities"] == ["file_read", "file_write", "network"]
    assert mixed["style"] == "composed-python"
    assert mixed["confidence"] == "high"
    assert mixed["paths"] == ["input.txt", "output.txt"]

    shell = analyze_ipython({"code": "!uv run python build.py\nprint('done')"})
    assert "shell" in shell["activities"]
    assert "package" in shell["activities"]
    assert shell["commands"] == ["uv run python build.py"]

    ordinary = analyze_ipython({"code": "values = [x * x for x in range(10)]\nsum(values)"})
    assert ordinary["activities"] == ["python"]
    assert ordinary["style"] == "python-only"

    wrapper = analyze_ipython({"code": "await cad.model.build({'part': 'demo'})"})
    assert wrapper["activities"] == ["cad_build"]
    assert wrapper["style"] == "tool-wrapper"
    assert wrapper["known_tools"] == ["cad.model.build"]

    hybrid = analyze_ipython({"code": """from pathlib import Path
spec = Path('spec.json').read_text()
model = await cad.model.build(spec)
print(model)
"""})
    assert hybrid["activities"] == ["cad_build", "file_read"]
    assert hybrid["style"] == "hybrid"
