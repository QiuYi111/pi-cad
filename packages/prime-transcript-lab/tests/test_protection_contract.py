"""RES-345 绿色保护套件（transcript 计量侧）。

这些行为今天已经正确，用小型合成 fixture 钉住，防止后续修复把它们改坏：

* 问题4「子 Agent 不漏账」：子会话用量计入 family 总量。
* 问题4「一次 IPython 里多个 CAD 动作分别计量」：逐动作计数来自真实事件。
* 问题4「错误不漏账」：工具结果标记错误时进入错误计数。
"""

from __future__ import annotations

import json
from pathlib import Path

from prime_trace.metrics import build_metrics
from prime_trace.parser import load_trace


def _write(path: Path, entries: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n", encoding="utf-8")


def _assistant(entry_id: str, parent: str | None, timestamp: str, *, content: list[dict], usage: dict, stop_reason: str = "toolUse") -> dict:
    return {
        "type": "message",
        "id": entry_id,
        "parentId": parent,
        "timestamp": timestamp,
        "message": {
            "role": "assistant",
            "content": content,
            "provider": "test-provider",
            "model": "test-model",
            "usage": usage,
            "stopReason": stop_reason,
        },
    }


def build_fixture(root: Path) -> Path:
    """两会话 fixture：根会话两个 IPython 单元，一个子 Agent 会话。"""
    root_session = root / "root.jsonl"
    _write(
        root_session,
        [
            {"type": "session", "version": 3, "id": "root-session", "timestamp": "2026-09-19T08:00:00.000Z", "cwd": str(root)},
            {"type": "message", "id": "u1", "parentId": None, "timestamp": "2026-09-19T08:00:01.000Z", "message": {"role": "user", "content": "设计一个支架并检查。"}},
            _assistant(
                "a1",
                "u1",
                "2026-09-19T08:00:05.000Z",
                content=[
                    {"type": "toolCall", "id": "call-1", "name": "ipython", "arguments": {"code": "await cad.model.build(spec_a)\nawait cad.model.build(spec_b)\nawait cad.probe.measure('wall')\n"}},
                ],
                usage={"input": 1200, "output": 130, "cacheRead": 500, "cacheWrite": 0, "totalTokens": 1830, "cost": {"total": 0.02}},
            ),
            {"type": "message", "id": "t1", "parentId": "a1", "timestamp": "2026-09-19T08:00:07.000Z", "message": {"role": "toolResult", "toolCallId": "call-1", "toolName": "ipython", "content": [{"type": "text", "text": "ok"}], "isError": False}},
            _assistant(
                "a2",
                "t1",
                "2026-09-19T08:00:12.000Z",
                content=[
                    {"type": "toolCall", "id": "call-2", "name": "ipython", "arguments": {"code": "await cad.probe.measure('hole')\n"}},
                ],
                usage={"input": 1500, "output": 90, "cacheRead": 200, "cacheWrite": 0, "totalTokens": 1790, "cost": {"total": 0.01}},
            ),
            {"type": "message", "id": "t2", "parentId": "a2", "timestamp": "2026-09-19T08:00:14.000Z", "message": {"role": "toolResult", "toolCallId": "call-2", "toolName": "ipython", "content": [{"type": "text", "text": "probe failed"}], "isError": True}},
            _assistant(
                "a3",
                "t2",
                "2026-09-19T08:00:20.000Z",
                content=[{"type": "text", "text": "检查完成。"}],
                usage={"input": 1900, "output": 80, "cacheRead": 300, "cacheWrite": 0, "totalTokens": 2280, "cost": {"total": 0.01}},
                stop_reason="endTurn",
            ),
        ],
    )
    _write(
        root / "child.jsonl",
        [
            {"type": "session", "version": 3, "id": "child-session", "timestamp": "2026-09-19T08:00:08.000Z", "cwd": str(root), "parentSession": "root.jsonl"},
            {"type": "session_info", "id": "si1", "parentId": None, "timestamp": "2026-09-19T08:00:08.100Z", "name": "geometry-scout"},
            {"type": "message", "id": "cu1", "parentId": "si1", "timestamp": "2026-09-19T08:00:09.000Z", "message": {"role": "user", "content": "[task from parent] 检查孔位。"}},
            _assistant(
                "ca1",
                "cu1",
                "2026-09-19T08:00:15.000Z",
                content=[{"type": "text", "text": "孔位正常。"}],
                usage={"input": 400, "output": 50, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 450, "cost": {"total": 0.005}},
                stop_reason="endTurn",
            ),
        ],
    )
    return root_session


def test_subagent_usage_counts_into_family_total(tmp_path: Path) -> None:
    metrics = build_metrics(load_trace(build_fixture(tmp_path), scan_dir=tmp_path))
    assert metrics["summary"]["subagent_count"] == 1
    # 根会话 1830 + 1790 + 2280 与子会话 450 全部计入 family。
    assert metrics["summary"]["family_usage"]["total"] == 6350
    assert metrics["summary"]["root_usage"]["total"] == 5900
    assert metrics["sessions"][1]["usage"]["total"] == 450


def test_one_ipython_cell_meters_each_cad_action(tmp_path: Path) -> None:
    metrics = build_metrics(load_trace(build_fixture(tmp_path), scan_dir=tmp_path))
    counts = {row["tool"]: row["call_count"] for row in metrics["known_tool_stats"]}
    # 同一个 IPython 单元里两次 build 各算一次，不并成一次。
    assert counts["cad.model.build"] == 2
    assert counts["cad.probe.measure"] == 2
    activities = {row["activity"] for row in metrics["ipython_activity_stats"]}
    assert {"cad_build", "cad_probe"} <= activities


def test_tool_result_error_is_counted(tmp_path: Path) -> None:
    metrics = build_metrics(load_trace(build_fixture(tmp_path), scan_dir=tmp_path))
    assert metrics["summary"]["tool_errors"] == 1
    errored = [cell for cell in metrics["ipython_cells"] if cell["is_error"]]
    assert len(errored) == 1
    assert errored[0]["known_tools"] == ["cad.probe.measure"]
