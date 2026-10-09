import type { KeyObject } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { HttpError } from './errors.js';

// Accepted by jose for ES256: a Node KeyObject or a WebCrypto CryptoKey.
export type KeyLike = KeyObject | CryptoKey;

export interface Clock {
  now(): Date;
}

export interface Keys {
  privateKey: KeyLike; // ES256 signing key
  publicKey: KeyLike; // ES256 verification key
}

export interface Deps {
  db: Db;
  keys: Keys;
  clock: Clock;
  config: Config;
}

// Anything with .query(): a pool or a checked-out client.
export interface Q {
  query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const AUDIENCE = 'reify-api';

export async function signAccess(d: Deps, userId: string): Promise<{ token: string; expiresIn: number }> {
  const iat = Math.floor(d.clock.now().getTime() / 1000);
  const ttl = d.config.accessTokenTtlSec;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(userId)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .sign(d.keys.privateKey);
  return { token, expiresIn: ttl };
}

// Returns the user id (sub) of a valid access token, or throws 401.
export async function verifyAccess(d: Deps, token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, d.keys.publicKey, {
      audience: AUDIENCE,
      algorithms: ['ES256'],
      currentDate: d.clock.now(),
    });
    if (typeof payload.sub !== 'string') throw new Error('no sub');
    return payload.sub;
  } catch {
    throw new HttpError(401, 'unauthorized', '登录已过期，请重新登录');
  }
}

// User id from "Authorization: Bearer <access token>", for active users only. Throws 401 otherwise.
export async function userIdFromAuth(d: Deps, authorization: string | undefined): Promise<string> {
  const m = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!m) throw new HttpError(401, 'unauthorized', '请先登录');
  const uid = await verifyAccess(d, m[1]);
  const r = await d.db.query<{ status: string }>('select status from users where id = $1', [uid]);
  if (r.rows[0]?.status !== 'active') throw new HttpError(401, 'unauthorized', '账户已停用');
  return uid;
}

export async function recordEvent(
  q: Q,
  e: { kind: string; at: Date; userId?: string | null; projectId?: string | null; workspaceId?: string | null; detail?: object },
) {
  await q.query(
    'insert into events (at, user_id, project_id, workspace_id, kind, detail) values ($1,$2,$3,$4,$5,$6)',
    [e.at, e.userId ?? null, e.projectId ?? null, e.workspaceId ?? null, e.kind, JSON.stringify(e.detail ?? {})],
  );
}
