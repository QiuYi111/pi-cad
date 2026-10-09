import { useState } from "react";
import type { CloudStatus } from "@shared/contracts";
import { DEFAULT_CLOUD_BASE_URL } from "@shared/contracts";
import { ChevronRight } from "../components/icons";
import { Wordmark } from "../components/Brand";
import { cloudErrorMessage } from "../lib/cloud-state";

/** Sign-in to the hosted service. `compact` renders the form without the page frame, for first run. */
export function CloudLogin({ baseUrl, onSignedIn, compact = false }: { baseUrl: string; onSignedIn: (status: CloudStatus) => void; compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState(baseUrl || DEFAULT_CLOUD_BASE_URL);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forgot, setForgot] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (server.trim() && server.trim() !== baseUrl) await window.piCad.settings.update({ cloud: { baseUrl: server.trim() } });
      onSignedIn(await window.piCad.cloud.login(email.trim(), password));
      setPassword("");
    } catch (reason) {
      setError(cloudErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const form = <form className="cloud-login-form" onSubmit={(event) => { event.preventDefault(); if (!busy && email.trim() && password) void submit(); }}>
    <label>邮箱<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} /></label>
    <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></label>
    {advanced && <label>服务器地址<input value={server} onChange={(event) => setServer(event.target.value)} disabled={busy} spellCheck={false} /></label>}
    {error && <p role="alert" className="cloud-error">{error}</p>}
    <div className="cloud-login-actions">
      <button type="submit" className="primary" disabled={busy || !email.trim() || !password}>{busy ? "正在登录…" : "登录"}<ChevronRight size={14} /></button>
      <button type="button" className="cloud-link" onClick={() => setAdvanced((value) => !value)}>{advanced ? "收起高级设置" : "高级设置"}</button>
    </div>
    <button type="button" className="cloud-link" aria-expanded={forgot} onClick={() => setForgot((value) => !value)}>忘记密码？</button>
    {forgot && <p className="cloud-hint">请联系管理员获取重置链接。</p>}
  </form>;

  if (compact) return <div className="cloud-login compact">{form}</div>;
  return <main className="cloud-gate">
    <header className="first-run-titlebar"><Wordmark /><span>Reify 云端</span></header>
    <section className="cloud-login">
      <h1>登录 Reify 云端</h1>
      <p className="cloud-hint">使用管理员为你开通的账户登录。工程文件保存在你的云端工作区。</p>
      {form}
    </section>
  </main>;
}
