"""RES-345 显式 red suite（transcript 计量侧）。

合约已冻结、实现未修。这些用例必须真实失败，不用 skip / xfail 假装通过。

    uv run --project packages/prime-transcript-lab --group dev pytest packages/prime-transcript-lab/red-tests

修复落地后转绿，再迁进 ``packages/prime-transcript-lab/tests``。
"""

from __future__ import annotations

import json
from pathlib import Path

from prime_trace.metrics import build_metrics
from prime_trace.parser import load_trace


def _write(path: Path, entries: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n", encoding="utf-8")


def _fixture(root: Path, entries: list[dict]) -> Path:
    path = root / "root.jsonl"
    _write(
        path,
        [
            {"type": "session", "version": 3, "id": "root-session", "timestamp": "2026-09-19T08:00:00.000Z", "cwd": str(root)},
            {"type": "message", "id": "u1", "parentId": None, "timestamp": "2026-09-19T08:00:01.000Z", "message": {"role": "user", "content": "跑一次 CAD 检查。"}},
            *entries,
        ],
    )
    return path


def test_provider_retry_attempts_are_metered(tmp_path: Path) -> None:
    """对应问题：RES-345 问题4，供应商重试不漏账。

    旧版失败：分析器不识别 provider 重试，summary 没有 retry 字段。
    预期行为：一次失败尝试加一次成功尝试记为 ``retry_attempts == 1``，
    且失败尝试的用量不丢。
    """
    path = _fixture(
        tmp_path,
        [
            {
                "type": "message",
                "id": "a1",
                "parentId": "u1",
                "timestamp": "2026-09-19T08:00:05.000Z",
                "message": {
                    "role": "assistant",
                    "content": [],
                    "provider": "test-provider",
                    "model": "test-model",
                    "stopReason": "error",
                    "errorMessage": "provider transport failure",
                    "usage": {"input": 1000, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 1000},
                },
            },
            {
                "type": "message",
                "id": "a2",
                "parentId": "a1",
                "timestamp": "2026-09-19T08:00:09.000Z",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "重试后完成。"}],
                    "provider": "test-provider",
                    "model": "test-model",
                    "stopReason": "endTurn",
                    "usage": {"input": 1100, "output": 40, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 1140},
                },
            },
        ],
    )
    metrics = build_metrics(load_trace(path, scan_dir=tmp_path))
    assert metrics["summary"]["retry_attempts"] == 1
    assert metrics["summary"]["family_usage"]["total"] == 2140


def test_output_error_tool_result_is_counted(tmp_path: Path) -> None:
    """对应问题：RES-345 问题4，工具错误不漏账。

    旧版失败：只认 ``isError``，运行器实际使用的 ``state: "output-error"`` 漏账。
    预期行为：两种错误标记都进入错误计数。
    """
    path = _fixture(
        tmp_path,
        [
            {
                "type": "message",
                "id": "a1",
                "parentId": "u1",
                "timestamp": "2026-09-19T08:00:05.000Z",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "toolCall", "id": "call-1", "name": "ipython", "arguments": {"code": "await cad.model.build(spec)\n"}}],
                    "provider": "test-provider",
                    "model": "test-model",
                    "stopReason": "toolUse",
                    "usage": {"input": 1000, "output": 30, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 1030},
                },
            },
            {
                "type": "message",
                "id": "t1",
                "parentId": "a1",
                "timestamp": "2026-09-19T08:00:08.000Z",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "call-1",
                    "toolName": "ipython",
                    "content": [{"type": "text", "text": "build failed"}],
                    "state": "output-error",
                },
            },
        ],
    )
    metrics = build_metrics(load_trace(path, scan_dir=tmp_path))
    assert metrics["summary"]["tool_errors"] == 1
    assert metrics["ipython_cells"][0]["is_error"] is True
