// reify-admin: operator CLI (plan §10). Run from the repo root:
//   DATABASE_URL=... PUBLIC_BASE_URL=https://<funnel> npx --prefix cloud/platform-api tsx cloud/admin/reify-admin.ts <command>
import { parseArgs } from 'node:util';
import { createPool } from '../platform-api/src/db.js';
import * as admin from '../platform-api/src/admin.js';
import { HttpError } from '../platform-api/src/errors.js';

const USAGE = `usage:
  invite create [--email x] [--uses 1] [--days 7] [--note text]
  invite list
  invite revoke <id>
  user list
  user disable <email>
  user enable <email>
  user reset-password <email>
  workspace list
  workspace stop <email>
  status`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    uses: { type: 'string' },
    days: { type: 'string' },
    note: { type: 'string' },
  },
});

const url = process.env.DATABASE_URL;
const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

async function run(db: ReturnType<typeof createPool>): Promise<void> {
  const now = new Date();
  const [group, cmd, arg] = positionals;
  const key = `${group} ${cmd}`;

  if (key === 'invite create') {
    if (!base) throw new Error('PUBLIC_BASE_URL is required');
    const inv = await admin.createInvite(db, now, base, {
      email: values.email,
      uses: values.uses === undefined ? undefined : Number(values.uses),
      days: values.days === undefined ? undefined : Number(values.days),
      note: values.note,
    });
    console.log(`邀请链接（只显示这一次）：\n${inv.url}\n过期时间：${inv.expiresAt.toISOString()}`);
  } else if (key === 'invite list') {
    console.table(await admin.listInvites(db, now));
  } else if (key === 'invite revoke') {
    if (!arg) throw new Error(USAGE);
    await admin.revokeInvite(db, now, arg);
    console.log('已撤销');
  } else if (key === 'user list') {
    console.table(await admin.listUsers(db));
  } else if (key === 'user disable') {
    if (!arg) throw new Error(USAGE);
    await admin.disableUser(db, now, arg);
    console.log('已停用，刷新令牌已作废，工作区已设为停止');
  } else if (key === 'user enable') {
    if (!arg) throw new Error(USAGE);
    await admin.enableUser(db, now, arg);
    console.log('已启用');
  } else if (key === 'user reset-password') {
    if (!arg) throw new Error(USAGE);
    if (!base) throw new Error('PUBLIC_BASE_URL is required');
    const r = await admin.createPasswordReset(db, now, base, arg);
    console.log(`一次性重置链接（24 小时内有效）：\n${r.url}\n过期时间：${r.expiresAt.toISOString()}`);
  } else if (key === 'workspace list') {
    console.table(await admin.listWorkspaces(db));
  } else if (key === 'workspace stop') {
    if (!arg) throw new Error(USAGE);
    await admin.stopWorkspaceByEmail(db, now, arg);
    console.log('已请求停止（控制器会先发送 shutdown，最多等 30 秒，然后缩容）');
  } else if (group === 'status' && !cmd) {
    const s = await admin.statusReport(db, now);
    console.log(`排队中：${s.queued}`);
    console.log('按状态统计：');
    console.table(s.countsByState);
    console.log('活跃工作区（期望运行或正在启动 / 运行）：');
    console.table(s.active);
    console.log(`最近 24 小时错误事件：${s.errorEventsLast24h}`);
    console.log('CPU 和内存未显示：本工具不连接 K8s 指标 API（metrics-server）。');
  } else {
    throw new Error(USAGE);
  }
}

if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const db = createPool(url, 2);
try {
  await run(db);
} catch (e) {
  console.error(e instanceof HttpError || e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.end();
}
