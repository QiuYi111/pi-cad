# @reify/workspace-gateway

WebSocket bridge gateway that runs inside a workspace pod. It serves the
`@reify/cloud-protocol` bridge protocol: exec, spawn with reattachable output,
verified file transfer, activity reporting and shutdown.

Environment: `REIFY_GATEWAY_PORT` (7000), `REIFY_GATEWAY_PUBKEY` (ES256 PEM),
`REIFY_WORKSPACE_NAME`, `REIFY_WORKSPACE_ROOT` (`/workspace`), `REIFY_ACTIVITY_URL`,
`REIFY_ACTIVITY_TOKEN`, `REIFY_ACTIVITY_IGNORE` (comma-separated command names).

Run with `npm start`; test with `npm test`.
