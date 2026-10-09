import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Config {
  publicBaseUrl: string; // e.g. https://reify.example.ts.net (no trailing slash)
  downloadUrl: string; // desktop installer link shown after registration (placeholder until packaging exists)
  trustProxy: boolean; // true: client IP is the first X-Forwarded-For entry
  accessTokenTtlSec: number; // 900
  refreshTokenTtlDays: number; // 30
  resetTokenTtlHours: number; // 24
  // Workspaces (plan 5.3 to 5.5)
  maxActiveWorkspaces: number; // 6
  workspaceNamespace: string; // reify-ws
  workspaceImage: string;
  workspaceTemplatePath: string; // cloud/deploy/k3s/workspace-template.yaml
  workspaceSeccompType: string; // RuntimeDefault | Unconfined (plan 0.5)
  workspaceHostUsers: string; // "true" | "false" (plan 0.5)
  httpsProxyForWorkspaces: string; // http://<windows-host>:7890, no credentials
  platformInternalUrl: string; // in-cluster base URL of the internal port, used for activity reports
  gatewayUrlPattern: string; // "{name}" is replaced with the workspace k8s name
  internalPort: number; // 8081: /internal/* only
  controllerIntervalMs: number; // 10 s
  idleWarnMs: number; // 25 min
  idleReclaimMs: number; // 30 min
  startTimeoutMs: number; // 5 min
  shutdownWaitMs: number; // 30 s
  bridgeTouchMs: number; // 30 s: at most one activity write per workspace per window
  trashRetentionMs: number; // 30 days: .trash entries older than this are deleted (plan 5.2)
  trashSweepMs: number; // 24 h: how often a running workspace is swept
}

export const DEFAULT_CONFIG: Config = {
  publicBaseUrl: 'http://localhost:8080',
  downloadUrl: 'https://example.invalid/reify-setup.exe',
  trustProxy: false,
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlDays: 30,
  resetTokenTtlHours: 24,
  maxActiveWorkspaces: 6,
  workspaceNamespace: 'reify-ws',
  workspaceImage: 'reify-workspace:dev',
  workspaceTemplatePath: fileURLToPath(new URL('../../deploy/k3s/workspace-template.yaml', import.meta.url)),
  workspaceSeccompType: 'RuntimeDefault',
  workspaceHostUsers: 'true',
  httpsProxyForWorkspaces: '',
  platformInternalUrl: 'http://platform-api.reify-system.svc.cluster.local:8081',
  gatewayUrlPattern: 'ws://{name}.reify-ws.svc:7000/',
  internalPort: 8081,
  controllerIntervalMs: 10_000,
  idleWarnMs: 25 * 60_000,
  idleReclaimMs: 30 * 60_000,
  startTimeoutMs: 5 * 60_000,
  shutdownWaitMs: 30_000,
  bridgeTouchMs: 30_000,
  trashRetentionMs: 30 * 24 * 60 * 60_000,
  trashSweepMs: 24 * 60 * 60_000,
};

function readPem(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value?.includes('BEGIN')) return value;
  const file = env[`${name}_FILE`] ?? (value && !value.includes('BEGIN') ? value : undefined);
  return file ? readFileSync(file, 'utf8') : undefined;
}

// Reads §5.5 env. JWT_PRIVATE_KEY and GATEWAY_PRIVATE_KEY may be a PEM string, or a path (or *_FILE) to a PEM file.
export function loadEnv(env: NodeJS.ProcessEnv = process.env) {
  const base = (env.PUBLIC_BASE_URL ?? DEFAULT_CONFIG.publicBaseUrl).replace(/\/+$/, '');
  const num = (v: string | undefined, fallback: number) => (v === undefined || v === '' ? fallback : Number(v));
  return {
    databaseUrl: env.DATABASE_URL,
    privateKeyPem: readPem(env, 'JWT_PRIVATE_KEY'),
    gatewayPrivateKeyPem: readPem(env, 'GATEWAY_PRIVATE_KEY'),
    port: Number(env.PORT ?? 8080),
    config: {
      ...DEFAULT_CONFIG,
      publicBaseUrl: base,
      downloadUrl: env.DOWNLOAD_URL ?? `${base}/download`,
      trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY ?? ''),
      maxActiveWorkspaces: num(env.MAX_ACTIVE_WORKSPACES, DEFAULT_CONFIG.maxActiveWorkspaces),
      workspaceNamespace: env.WORKSPACE_NAMESPACE ?? DEFAULT_CONFIG.workspaceNamespace,
      workspaceImage: env.WORKSPACE_IMAGE ?? DEFAULT_CONFIG.workspaceImage,
      workspaceTemplatePath: env.WORKSPACE_TEMPLATE_PATH ?? DEFAULT_CONFIG.workspaceTemplatePath,
      workspaceSeccompType: env.WORKSPACE_SECCOMP_TYPE ?? DEFAULT_CONFIG.workspaceSeccompType,
      workspaceHostUsers: env.WORKSPACE_HOST_USERS ?? DEFAULT_CONFIG.workspaceHostUsers,
      httpsProxyForWorkspaces: env.HTTPS_PROXY_FOR_WORKSPACES ?? DEFAULT_CONFIG.httpsProxyForWorkspaces,
      platformInternalUrl: env.PLATFORM_INTERNAL_URL ?? DEFAULT_CONFIG.platformInternalUrl,
      gatewayUrlPattern: env.GATEWAY_URL_PATTERN ?? DEFAULT_CONFIG.gatewayUrlPattern,
      internalPort: num(env.INTERNAL_PORT, DEFAULT_CONFIG.internalPort),
    } satisfies Config,
  };
}
