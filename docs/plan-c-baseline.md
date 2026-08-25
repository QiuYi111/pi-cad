# Plan C baseline

Recorded before the Plan C implementation on 2026-08-25.

- pi-cad baseline: `0a718b939fb86c3ea020550f7177472b0e2da5af`
- Prime upstream baseline: `9e49b73` in isolated worktree
  `/home/jingyi/prime-agent-plan-c-upstream`
- Prime Agent: `0.8.0`, launched from its source `prime-agent.sh`
- `f994922` is a separate Plan B Host Bridge experiment and is excluded from
  Plan C acceptance.
- npm `@earendil-works/pi-coding-agent@0.84.2` is Pi compatibility infrastructure,
  not Prime Agent, and its results do not satisfy the Prime boundary.
- TypeScript suite: 230/230 passed
- Python suite: 82 passed, 7 skipped
- Agent route golden tests: 26/26 passed
- Full baseline elapsed time: 5m 15s

The existing Prime public context hook and custom-message conversion path are
the integration seam. The legacy suite counts above establish Pi-CAD regression
health only; separate `test:prime` and real `prime-agent.sh` scenarios establish
the Plan C Prime boundary.
