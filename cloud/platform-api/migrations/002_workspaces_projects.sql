-- Phase 1, second migration: refresh-token revocation reasons (plan 5.1), per-workspace activity
-- tokens (plan 7.4) and the workspace start queue (plan 5.3).

-- Only 'rotated' triggers reuse detection (revoke all). Other reasons just return 401.
-- Tokens revoked by reuse detection itself keep a null reason.
alter table refresh_tokens add column revoked_reason text
  check (revoked_reason in ('rotated','logout','password_change','reset','disabled'));

-- sha256 of the plaintext token the controller gave the workspace pod (REIFY_ACTIVITY_TOKEN).
alter table workspaces add column activity_token_hash bytea;

-- Requests to start while the active limit is full. seq gives the queue order.
create table workspace_queue (
  seq bigserial primary key,
  workspace_id uuid not null unique references workspaces(id),
  queued_at timestamptz not null default now()
);
