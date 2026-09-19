#!/usr/bin/env bash
# RES-345 显式 red suite：合约已冻结、实现未修的回归用例。
# 这里预期非 0 退出；不用 skip / xfail 假装通过。
set -u

status=0
node --test tests/red/experiment-protection.red.test.mjs || status=1
uv run --project packages/prime-transcript-lab --group dev pytest packages/prime-transcript-lab/red-tests -q || status=1
exit "$status"
