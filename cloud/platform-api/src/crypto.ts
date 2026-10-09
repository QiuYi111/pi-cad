import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

// Opaque random token, base64url. Store only sha256(token).
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

// Constant-time equality for two byte buffers of any length.
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const normalizeEmail = (s: string) => s.trim().toLowerCase();

const ARGON2 = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 } as const;

export const hashPassword = (pw: string) => argon2.hash(pw, ARGON2);

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

// Used to spend the same argon2 time when the email does not exist, so timing does not reveal accounts.
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword(newToken()));

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
