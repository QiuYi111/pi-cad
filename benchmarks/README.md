# Pi-CAD empirical benchmark

This directory measures the same task corpus across three configurations:

1. `bare` — Pi with no extensions and no CAD skill.
2. `cad-skill` — Pi with the frozen `ref/cad-skill` loaded as a skill.
3. `pi-cad` — the Pi-CAD package (default core/geometry/visual/ui).

## Metrics

| Metric | Source |
| --- | --- |
| success | process exit + expected files + `.pi-cad/state.json` phase |
| wall time | measured around the `pi -p` process |
| model tokens | sum of assistant message `usage.totalTokens` in the session JSONL |
| tool calls | count of `toolCall` entries in the session JSONL |
| user turns | count of `role=user` messages |
| iterations | count of `cad_commit_candidate` tool calls for Pi-CAD; analogous calls for cad-skill |
| error events | count of `output-error` tool results / non-zero exits |

## Runner

```bash
node benchmarks/run.mjs --tasks quick-plate --configs bare,cad-skill,pi-cad
```

Environment expected:

- `PI_CODING_AGENT_DIR` points to a writable agent dir with CodeX auth.
- `PI_CAD_REPO` defaults to this repository.
- `PI_CAD_MODEL` defaults to `gpt-5.6-luna`.
- `PI_CAD_THINKING` defaults to `medium`.
- `PI_CAD_TIMEOUT_MS` defaults to `600000`.

Results land in `benchmarks/results/<run-id>/`.
