import type { Deps } from './deps.js';
import { sha256, TOKEN_RE } from './crypto.js';

export type InviteReason = 'not_found' | 'revoked' | 'expired' | 'used';

export const INVITE_MESSAGES: Record<InviteReason, string> = {
  not_found: '邀请链接无效',
  revoked: '邀请已被撤销',
  expired: '邀请已过期',
  used: '邀请已被用完',
};

export interface InviteRow {
  id: string;
  email: string | null;
  max_uses: number;
  used_count: number;
  expires_at: Date;
  revoked_at: Date | null;
}

// Null when the invite can be used now.
export function inviteReason(inv: InviteRow, now: Date): InviteReason | null {
  if (inv.revoked_at) return 'revoked';
  if (inv.expires_at.getTime() <= now.getTime()) return 'expired';
  if (inv.used_count >= inv.max_uses) return 'used';
  return null;
}

export const inviteHash = (token: string) => sha256(token);

export const isInviteTokenShape = (t: unknown): t is string => typeof t === 'string' && TOKEN_RE.test(t);

// GET /v1/invites/:token: validity and the bound email (if any). Never throws for a bad token.
export async function getInvite(d: Deps, token: string): Promise<{ valid: boolean; reason?: InviteReason; email?: string }> {
  if (!isInviteTokenShape(token)) return { valid: false, reason: 'not_found' };
  const r = await d.db.query<InviteRow>(
    'select id, email, max_uses, used_count, expires_at, revoked_at from invites where token_hash = $1',
    [inviteHash(token)],
  );
  const inv = r.rows[0];
  if (!inv) return { valid: false, reason: 'not_found' };
  const reason = inviteReason(inv, d.clock.now());
  if (reason) return { valid: false, reason };
  return inv.email ? { valid: true, email: inv.email } : { valid: true };
}
