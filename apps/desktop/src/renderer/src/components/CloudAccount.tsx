import { useState } from "react";
import { cloudErrorMessage } from "../lib/cloud-state";

/** Minimum length the platform API accepts for a password (plan §5.1). */
export const MIN_PASSWORD_LENGTH = 10;

/** Password change for the signed-in account, shown in Settings in cloud mode. Sign-out ends the session everywhere on this app. */
export function CloudAccount({ email }: { email?: string }) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const change = async () => {
    setError("");
    setNotice("");
    if (newPassword.length < MIN_PASSWORD_LENGTH) { setError(`新密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`); return; }
    if (newPassword !== confirm) { setError("两次输入的新密码不一致。"); return; }
    setBusy(true);
    try {
      await window.piCad.cloud.changePassword(oldPassword, newPassword);
      setOldPassword("");
      setNewPassword("");
      setConfirm("");
      setNotice("密码已修改。其他设备需要重新登录。");
    } catch (reason) {
      setError(cloudErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError("");
    try {
      await window.piCad.cloud.logout();
    } catch (reason) {
      setError(cloudErrorMessage(reason));
      setBusy(false);
    }
  };

  return <section id="settings-account-cloud" className="settings-card wide cloud-account">
    <header><div><div><h2>云端账户</h2><p>{email ? `已登录为 ${email}` : "未登录"}</p></div></div></header>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy) void change(); }}>
      <label>当前密码<input type="password" autoComplete="current-password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} disabled={busy} /></label>
      <label>新密码<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={busy} /></label>
      <label>确认新密码<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} disabled={busy} /></label>
      {error && <p role="alert" className="cloud-error">{error}</p>}
      {notice && <p role="status" className="cloud-hint">{notice}</p>}
      <div className="cloud-account-actions">
        <button type="submit" className="primary" disabled={busy || !oldPassword || !newPassword || !confirm}>修改密码</button>
        <button type="button" onClick={() => void signOut()} disabled={busy}>退出登录</button>
      </div>
    </form>
  </section>;
}
