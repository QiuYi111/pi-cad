# syntax=docker/dockerfile:1
#
# Platform API image (plan section 5). Build with cloud/platform-api/build.sh.
# Build context: the repository root (the Dockerfile copies cloud/ paths).
#
# The server and the migration CLI run TypeScript through tsx, so tsx is a runtime dependency.
# Layout matches the repository, so the default paths in src/ still resolve:
#   /app/cloud/platform-api                        code; migrations/ sits next to src/
#   /app/cloud/admin                               reify-admin
#   /app/cloud/protocol                            shared protocol sources
#   /app/cloud/deploy/k3s/workspace-template.yaml  rendered by the workspace controller
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    npm_config_update_notifier=false

WORKDIR /app/cloud/platform-api

COPY cloud/platform-api/package.json cloud/platform-api/package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY cloud/platform-api/tsconfig.json ./
COPY cloud/platform-api/src ./src
COPY cloud/platform-api/migrations ./migrations
COPY cloud/admin /app/cloud/admin
COPY cloud/protocol /app/cloud/protocol
COPY cloud/deploy/k3s/workspace-template.yaml /app/cloud/deploy/k3s/workspace-template.yaml

# Numeric uid, matching runAsUser in platform-api.yaml. Nothing here writes into the image.
USER 10001:10001

# 8080 public API (behind Caddy). 8081 internal API (workspace activity only).
EXPOSE 8080 8081

# Migrations first, then the server. exec makes node PID 1, so SIGTERM reaches it.
CMD ["sh", "-c", "node_modules/.bin/tsx src/migrate-cli.ts && exec node_modules/.bin/tsx src/server.ts"]
