# Reify CAD worker MCP

A local MCP server that delegates CAD/mechanical work to the existing Prime Agent + Pi-CAD runtime. It is a transport/control layer: it launches the long-lived Prime RPC session, keeps cwd stable, returns compact status/events, and exposes artifact handles. It does not add a second CAD API or return the full Prime transcript.

## Tools

- `cad_worker.start(cwd, workflow?, prompt?, model?, permission?)`
- `cad_worker.send(session_id, prompt)`
- `cad_worker.status(session_id)`
- `cad_worker.events(session_id, after?, limit?)`
- `cad_worker.artifacts(session_id)`
- `cad_worker.steer(session_id, instruction)`
- `cad_worker.interrupt(session_id)`
- `cad_worker.cancel(session_id, reason?)`
- `cad_worker.request_checkpoint(session_id)`
- `cad_worker.close(session_id)`

`USER_DECISION_REQUIRED` and `BLOCKED` are preserved rather than guessed away. `events` is bounded and cursor-based. Results expose Linux/WSL plus Windows UNC paths when the caller is Windows.

## WSL Codex

Register repository-relative entry:

```bash
node packages/reify-cad-worker/mcp.mjs
```

The host must have Pi-CAD runtime dependencies, `/usr/bin/bwrap`, Prime credentials/config, and a project directory. The worker resolves Prime from `$PRIME_AGENT_REPO` or `~/.prime/agent/prime-cad.json`. Defaults can be overridden with `REIFY_PI_CAD_REPO`, `REIFY_NODE`, `REIFY_WORKER_PROVIDER`, `REIFY_WORKER_MODEL`, and `REIFY_WORKER_THINKING`.

## Windows Codex

Run the same script on Windows:

```powershell
node packages\reify-cad-worker\mcp.mjs
```

It converts the MCP entry and Windows project paths through `wsl.exe`, then runs the identical WSL server. Set `REIFY_WSL_DISTRO` if the distro is not `Ubuntu`. Set `REIFY_PI_CAD_REPO` to a native WSL Pi-CAD checkout/runtime for best performance. No Windows-side Pi-CAD process is created.

## Local checks

```bash
node tests/reify-cad-worker.test.mjs
```

The test suite covers lifecycle/follow-up/cancel/close/stale IDs, compact context boundary, canonical blocker/resume, repeated-failure monitoring, same-session steering/interrupt, MCP catalog/call mapping, and host path policy.

## Windows entry variables

On Windows the bridge needs a native WSL Node path when the default shell cannot find one:

```powershell
$env:REIFY_WSL_DISTRO="Ubuntu"
$env:REIFY_WORKER_WSL_ENTRY="/home/<you>/pi-cad/packages/reify-cad-worker/mcp.mjs"
$env:REIFY_WORKER_WSL_NODE="/home/<you>/.local/lib/nodejs/node-v22.23.2-linux-x64/bin/node"
node .\packages\reify-cad-worker\mcp.mjs
```

If the package is checked out on `C:\`, only `REIFY_WORKER_WSL_NODE` normally needs to be set. The bridge converts Windows `cwd` arguments through `wslpath`; artifact results contain Windows UNC forms.

## Limitations and recommendation

Keep this worker local-only for now. Prime credentials, CAD project files, bwrap isolation, and long-running sessions assume a trusted local desktop/WSL boundary; a remote worker would need an authenticated service boundary, workload authorization, artifact transport, and reconnectable sessions.

Current limitations:

- `pause`/`resume` are not exposed; `interrupt` preserves the session, but Prime controls whether queued steering is accepted.
- `request_checkpoint` consumes one Prime turn.
- Windows→WSL transport, path conversion, status, artifact handles, and a real `mechanical.quick-build` delivery E2E were exercised.
- `mechanical.mechanism-design` is not in the current workflow catalog; callers choose the closest available workflow such as `mechanical.design`.
- MCP status uses a child Agent API read; simultaneous status calls are best kept modest.
