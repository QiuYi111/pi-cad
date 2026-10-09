# @reify/platform-api

Account, invite and session service for the Reify hosted service (phase 1). Fastify + PostgreSQL 16.
Design: `reify-2.0/saas/implementation-plan.zh-CN.md` §4, §5.1, §5.5, §10.

## Setup

```sh
cd cloud/platform-api
npm ci
```

## Migrations

Plain SQL in `migrations/`, applied in filename order and recorded in `schema_migrations`.

```sh
DATABASE_URL=postgres://user:pass@host/reify npm run migrate
```

## Server

Environment (plan §5.5):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | required |
| `JWT_PRIVATE_KEY` | ES256 private key, PEM (PKCS#8 or SEC1) |
| `JWT_PRIVATE_KEY_FILE` | alternative: path to the PEM file |
| `PUBLIC_BASE_URL` | e.g. `https://<funnel host>`; used in invite and reset links |
| `DOWNLOAD_URL` | optional; installer link shown after registration (default `${PUBLIC_BASE_URL}/download`) |
| `TRUST_PROXY` | `1`/`true` to take the client IP from the first `X-Forwarded-For` entry |
| `PORT` | default `8080` |

Workspace settings (plan 5.5, 8.2). Defaults are in `src/config.ts`:

| Variable | Notes |
|---|---|
| `GATEWAY_PRIVATE_KEY` / `_FILE` | ES256 PEM for the 60 s gateway tokens. Required. A second key, not `JWT_PRIVATE_KEY` |
| `INTERNAL_PORT` | default `8081`. Serves `/internal/*` only |
| `MAX_ACTIVE_WORKSPACES` | default `6` |
| `WORKSPACE_IMAGE` | image for the workspace pod |
| `WORKSPACE_NAMESPACE` | default `reify-ws` |
| `WORKSPACE_TEMPLATE_PATH` | default `cloud/deploy/k3s/workspace-template.yaml`, relative to this package |
| `WORKSPACE_SECCOMP_TYPE`, `WORKSPACE_HOST_USERS` | filled into the template (plan 0.5) |
| `HTTPS_PROXY_FOR_WORKSPACES` | `http://<windows host>:7890`, no credentials |
| `PLATFORM_INTERNAL_URL` | in-cluster base of the internal port, for the activity URL |
| `GATEWAY_URL_PATTERN` | default `ws://{name}.reify-ws.svc:7000/` |

The controller runs in the same process every 10 s (`controllerIntervalMs` in config).
Kubernetes access uses the in-cluster service account (or `KUBECONFIG`), limited by `platform-api-rbac.yaml`.

```sh
DATABASE_URL=... JWT_PRIVATE_KEY_FILE=./jwt.pem GATEWAY_PRIVATE_KEY_FILE=./gw.pem PUBLIC_BASE_URL=https://example.ts.net npm start
```

Routes (public port): `GET /v1/healthz`, `GET /v1/invites/:token`, `POST /v1/auth/{register,login,refresh,logout,password,reset}`,
`GET /v1/me`, `GET|POST /v1/projects`, `PATCH|DELETE /v1/projects/:id`,
`GET /v1/workspace`, `POST /v1/workspace/{start,stop,keepalive}`, WebSocket `GET /v1/workspace/bridge` and `GET /v1/events`
(both take the access token in `Authorization: Bearer`), and HTML pages `GET /invite/:token`, `GET /reset/:token`.

Internal port (not routed by Caddy): `POST /internal/workspaces/:id/activity`, authenticated with the workspace's own token.

## Admin CLI

Run from the repo root (`cloud/admin/reify-admin.ts`, uses the same `DATABASE_URL`; `PUBLIC_BASE_URL` for links):

```sh
export DATABASE_URL=... PUBLIC_BASE_URL=https://example.ts.net
cd cloud/platform-api
npx tsx ../admin/reify-admin.ts invite create [--email x] [--uses 1] [--days 7] [--note text]
npx tsx ../admin/reify-admin.ts invite list
npx tsx ../admin/reify-admin.ts invite revoke <id>
npx tsx ../admin/reify-admin.ts user list
npx tsx ../admin/reify-admin.ts user disable <email>
npx tsx ../admin/reify-admin.ts user enable <email>
npx tsx ../admin/reify-admin.ts user reset-password <email>
npx tsx ../admin/reify-admin.ts workspace list
npx tsx ../admin/reify-admin.ts workspace stop <email>
npx tsx ../admin/reify-admin.ts status
```

`status` does not show CPU or memory. It does not connect to the metrics API.

The invite token and reset token are printed once. Only their sha256 is stored.

## Tests

```sh
npm test
```

Tests need PostgreSQL 16 binaries. By default they start a throwaway cluster in a temp dir
(`initdb` + `pg_ctl`, random port, unix socket in the temp dir; `PG_BIN_DIR` overrides `/usr/lib/postgresql/16/bin`).
When run as root, the cluster runs as the `postgres` user. To use an existing server (e.g. CI services):

```sh
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test
```

Each test file and each test gets its own database on that server, dropped afterwards.

## Layout

- `src/app.ts` - `buildApp({db, keys, clock, config})`, routes, `requireUser` preHandler
- `src/auth.ts` - registration, login and lockout, refresh rotation, password change and reset
- `src/invites.ts`, `src/admin.ts` - invite validity; operator functions shared with the CLI
- `src/migrate.ts` - migration runner
- `src/pages.ts` - invite and reset pages (plain HTML and inline JS)
- `src/projects.ts` - projects, membership, soft delete, filesystem changes through the gateway
- `src/internal.ts` - the internal app (activity reports), served on `INTERNAL_PORT` only
- `src/workspace/` - `service.ts` (start with capacity and queue, stop, keepalive), `controller.ts` (the 5 rules of plan 5.4),
  `template.ts` (renders the workspace template), `k8s.ts` (Kubernetes client, limited to reify-ws), `gateway.ts`
  (gateway tokens, exec and shutdown), `bridge.ts` (WebSocket upgrades: bridge and events), `events.ts`, `ports.ts` (interfaces the tests fake)
