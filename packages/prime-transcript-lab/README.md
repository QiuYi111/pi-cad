# Prime Transcript Lab

Repository-owned forensic analyzer for Prime Agent JSONL sessions.

```bash
uv run --project packages/prime-transcript-lab prime-trace session.jsonl \
  --scan-dir .prime-sessions \
  -o transcript-analysis
```

It emits a self-contained `report.html`, readable `transcript.md`,
normalized `events.jsonl`, `metrics.json`, CSV tables, per-agent views, and
externalized artifacts. Pi-CAD uses this package when archiving completed
trajectories; runtime behavior does not depend on a user-level Codex skill
installation.

API usage and timestamps are source values. Payload token shares are
character-based estimates, and model response gaps are inferred from transcript
timestamps rather than provider-side latency.
