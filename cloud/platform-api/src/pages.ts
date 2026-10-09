// Minimal static pages: plain HTML, inline CSS and JS, Chinese UI text. No frameworks.

const css = `
body{margin:0;font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1d2330}
main{max-width:420px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;margin:0 0 12px}
label{display:block;margin:14px 0 0;font-size:14px}
input{display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:10px;font:inherit;border:1px solid #c5ccd6;border-radius:6px;background:#fff}
button{margin-top:20px;width:100%;padding:12px;font:inherit;border:0;border-radius:6px;background:#2857d6;color:#fff;cursor:pointer}
button:disabled{background:#9aa6bf;cursor:default}
.err{color:#b42318;min-height:1.6em;margin:12px 0 0}
.note{color:#56607a;font-size:14px}
[hidden]{display:none!important}
@media (prefers-color-scheme:dark){body{background:#14171d;color:#e6e9ef}input{background:#1d2129;color:#e6e9ef;border-color:#3a4150}.note{color:#9aa3b5}}
`;

const layout = (title: string, main: string, script: string) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<main>
${main}
</main>
<script>
${script}
</script>
</body>
</html>
`;

// Embeds a value in a <script> block safely.
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const apiPost = `
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || '请求失败，请稍后再试');
  return d;
}
const $ = (id) => document.getElementById(id);
const tokenFromPath = () => decodeURIComponent(location.pathname.split('/').pop() || '');
`;

export function invitePage(downloadUrl: string): string {
  const main = `
<h1>注册 Reify 账户</h1>
<p id="status" class="note">正在检查邀请链接…</p>
<form id="f" hidden>
  <label>邮箱（用于登录）<input id="email" type="email" required autocomplete="email" maxlength="254"></label>
  <label>显示名<input id="name" autocomplete="nickname" maxlength="64" placeholder="可留空"></label>
  <label>密码（至少 10 个字符）<input id="pw" type="password" required minlength="10" autocomplete="new-password"></label>
  <label>确认密码<input id="pw2" type="password" required minlength="10" autocomplete="new-password"></label>
  <button id="btn" type="submit">注册</button>
  <p id="err" class="err" role="alert"></p>
</form>
<section id="done" hidden>
  <h1>注册成功</h1>
  <p>账户已创建。请下载桌面应用，然后用邮箱和密码登录。</p>
  <p><a id="dl" href="${downloadUrl.replace(/"/g, '&quot;')}">下载桌面应用</a></p>
</section>`;
  const script = `
${apiPost}
const DOWNLOAD_URL = ${js(downloadUrl)};
const token = tokenFromPath();
(async () => {
  try {
    const d = await fetch('/v1/invites/' + encodeURIComponent(token)).then((r) => r.json());
    if (!d.valid) {
      $('status').textContent = d.message || '邀请链接无效';
      return;
    }
    if (d.email) { $('email').value = d.email; $('email').readOnly = true; }
    $('status').hidden = true;
    $('f').hidden = false;
  } catch (e) {
    $('status').textContent = '无法连接服务器，请稍后再试';
  }
})();
$('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('err').textContent = '';
  if ($('pw').value !== $('pw2').value) { $('err').textContent = '两次输入的密码不一致'; return; }
  $('btn').disabled = true;
  try {
    await post('/v1/auth/register', {
      inviteToken: token,
      email: $('email').value,
      displayName: $('name').value,
      password: $('pw').value,
    });
    $('f').hidden = true;
    $('done').hidden = false;
    $('dl').href = DOWNLOAD_URL;
  } catch (e) {
    $('err').textContent = e.message;
    $('btn').disabled = false;
  }
});
`;
  return layout('注册 Reify', main, script);
}

export function resetPage(): string {
  const main = `
<h1>重置密码</h1>
<form id="f">
  <label>新密码（至少 10 个字符）<input id="pw" type="password" required minlength="10" autocomplete="new-password"></label>
  <label>确认新密码<input id="pw2" type="password" required minlength="10" autocomplete="new-password"></label>
  <button id="btn" type="submit">设置新密码</button>
  <p id="err" class="err" role="alert"></p>
</form>
<section id="done" hidden>
  <h1>密码已重置</h1>
  <p>请回到桌面应用，用新密码登录。</p>
</section>`;
  const script = `
${apiPost}
$('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('err').textContent = '';
  if ($('pw').value !== $('pw2').value) { $('err').textContent = '两次输入的密码不一致'; return; }
  $('btn').disabled = true;
  try {
    await post('/v1/auth/reset', { token: tokenFromPath(), newPassword: $('pw').value });
    $('f').hidden = true;
    $('done').hidden = false;
  } catch (e) {
    $('err').textContent = e.message;
    $('btn').disabled = false;
  }
});
`;
  return layout('重置 Reify 密码', main, script);
}
