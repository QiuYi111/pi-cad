import { readFileSync } from 'node:fs';

export interface Config {
  publicBaseUrl: string; // e.g. https://reify.example.ts.net (no trailing slash)
  downloadUrl: string; // desktop installer link shown after registration (placeholder until packaging exists)
  trustProxy: boolean; // true: client IP is the first X-Forwarded-For entry
  accessTokenTtlSec: number; // 900
  refreshTokenTtlDays: number; // 30
  resetTokenTtlHours: number; // 24
}

export const DEFAULT_CONFIG: Config = {
  publicBaseUrl: 'http://localhost:8080',
  downloadUrl: 'https://example.invalid/reify-setup.exe',
  trustProxy: false,
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlDays: 30,
  resetTokenTtlHours: 24,
};

// Reads §5.5 env. JWT_PRIVATE_KEY may be a PEM string or a path to a PEM file.
export function loadEnv(env: NodeJS.ProcessEnv = process.env) {
  const base = (env.PUBLIC_BASE_URL ?? DEFAULT_CONFIG.publicBaseUrl).replace(/\/+$/, '');
  const pem = env.JWT_PRIVATE_KEY?.includes('BEGIN')
    ? env.JWT_PRIVATE_KEY
    : env.JWT_PRIVATE_KEY_FILE
      ? readFileSync(env.JWT_PRIVATE_KEY_FILE, 'utf8')
      : env.JWT_PRIVATE_KEY
        ? readFileSync(env.JWT_PRIVATE_KEY, 'utf8')
        : undefined;
  return {
    databaseUrl: env.DATABASE_URL,
    privateKeyPem: pem,
    port: Number(env.PORT ?? 8080),
    config: {
      ...DEFAULT_CONFIG,
      publicBaseUrl: base,
      downloadUrl: env.DOWNLOAD_URL ?? `${base}/download`,
      trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY ?? ''),
    } satisfies Config,
  };
}
