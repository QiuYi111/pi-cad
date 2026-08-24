# Plan C baseline

Recorded before the Plan C implementation on 2026-08-25.

- pi-cad baseline: `0a718b939fb86c3ea020550f7177472b0e2da5af`
- Prime checkout: `f994922`
- Prime CLI: `0.84.2`
- TypeScript suite: 230/230 passed
- Python suite: 82 passed, 7 skipped
- Agent route golden tests: 26/26 passed
- Full baseline elapsed time: 5m 15s

The existing Prime public context hook and custom-message conversion path were
used as the integration seam. Plan C adds a new bounded phase-card latency
metric; there was no equivalent card compiler in the baseline.
