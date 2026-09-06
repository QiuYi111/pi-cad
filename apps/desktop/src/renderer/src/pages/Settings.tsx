import { useEffect, useState } from "react";
import { Check, ChevronRight, FolderOpen, RefreshCw, Wrench } from "../components/icons";
import type { AppSettings, AuthStatus, InstallationInfo, RuntimeStatus, ThinkingLevel } from "@shared/contracts";

const levels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function Settings({ value, onChange }: { value: AppSettings; onChange: (value: AppSettings) => void | Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: "checking", checks: [] });
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [auth, setAuth] = useState<AuthStatus>({ provider: "openai-codex", state: "checking" });
  const [authInput, setAuthInput] = useState("");
  const [installation, setInstallation] = useState<InstallationInfo | null>(null);
  const check = () => window.piCad.runtime.check().then(setRuntime).catch((error) => setRuntime({ state: "error", checks: [], message: String(error) }));
  useEffect(() => {
    void check();
    void window.piCad.auth.status().then(setAuth);
    void window.piCad.system.installationInfo().then(setInstallation);
    return window.piCad.auth.onStatus(setAuth);
  }, []);
  useEffect(() => { setDraft(value); }, [value]);
  const patch = <K extends keyof AppSettings>(key: K, next: AppSettings[K]) => setDraft((current) => ({ ...current, [key]: next }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  const save = async () => {
    setSaving(true); setSaveMessage("");
    try { const next = await window.piCad.settings.update(draft); await onChange(next); setDraft(next); setSaveMessage("Changes saved."); }
    catch (error) { setSaveMessage(`Save failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setSaving(false); }
  };
  const chooseProject = async () => { const path = await window.piCad.settings.chooseProject(); if (path) patch("projectPath", path); };
  return <div className="settings-page page-scroll" data-testid="settings-page">
    <header className="page-heading"><div><span>Preferences</span><h1>Providers and runtime</h1><p>Choose where engineering runs and which models make decisions.</p></div><div className="settings-save"><button className="primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : dirty ? "Save changes" : "Saved"}</button>{saveMessage && <small role={saveMessage.startsWith("Save failed") ? "alert" : "status"}>{saveMessage}</small>}</div></header>
    <nav className="settings-index" aria-label="Settings sections"><button onClick={() => document.getElementById("settings-project")?.scrollIntoView({ behavior: "smooth" })}>Project</button><button onClick={() => document.getElementById("settings-model")?.scrollIntoView({ behavior: "smooth" })}>Account & model</button><button onClick={() => document.getElementById("settings-runtime")?.scrollIntoView({ behavior: "smooth" })}>Runtime</button><button onClick={() => document.getElementById("settings-advanced")?.scrollIntoView({ behavior: "smooth" })}>Advanced</button></nav>
    <div className="settings-grid">
      <section id="settings-project" className="settings-card wide"><header><div><span className="setting-icon"><FolderOpen size={18} /></span><div><h2>Project</h2><p>Prime and Reify only receive this workspace.</p></div></div></header><div className="path-picker"><code>{draft.projectPath || "No project selected"}</code><button onClick={() => void chooseProject()}>Choose folder</button></div></section>
      <section id="settings-model" className="settings-card"><header><div><span className="setting-icon blue"><span className="provider-mark" /></span><div><h2>Author model</h2><p>Used for design and engineering work.</p></div></div></header>
        <label>Provider<select value={draft.provider} onChange={(event) => patch("provider", event.target.value)}><option value="openai-codex">OpenAI Codex</option><option value="prime">Prime Inference</option><option value="zai">Z.AI</option><option value="openrouter">OpenRouter</option></select></label>
        <label>Default model<input value={draft.model} onChange={(event) => patch("model", event.target.value)} /></label>
        <label>Reasoning<select value={draft.thinking} onChange={(event) => patch("thinking", event.target.value as ThinkingLevel)}>{levels.map((level) => <option key={level}>{level}</option>)}</select></label>
        <div className="auth-row"><div><i className={auth.state === "signed-in" ? "online" : ""} /><span>{auth.message || auth.state}</span></div>{auth.state === "signed-in" ? <button onClick={() => void window.piCad.auth.signOut().then(setAuth)}>退出登录</button> : auth.state === "waiting" ? <button onClick={() => void window.piCad.auth.cancel().then(setAuth)}>Cancel</button> : <button onClick={() => void window.piCad.auth.login().then(setAuth)}>Sign in with ChatGPT</button>}</div>
        {auth.input && <div className="auth-input">{auth.input.kind === "select" ? <select value={authInput} onChange={(event) => setAuthInput(event.target.value)}><option value="">Choose an account</option>{auth.input.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : <input value={authInput} placeholder={auth.input.placeholder || "Paste the redirect URL"} onChange={(event) => setAuthInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && authInput.trim()) { void window.piCad.auth.submitManualCode(authInput.trim()); setAuthInput(""); } }} />}<button className="primary" disabled={!authInput.trim()} onClick={() => { void window.piCad.auth.submitManualCode(authInput.trim()); setAuthInput(""); }}>Continue</button></div>}
      </section>
      <section className="settings-card"><header><div><span className="setting-icon"><Check size={18} /></span><div><h2>Independent reviewer</h2><p>Defaults to the active author model.</p></div></div></header>
        <div className="segmented"><button className={draft.reviewer.mode === "inherit" ? "active" : ""} onClick={() => patch("reviewer", { mode: "inherit" })}>Inherit author</button><button className={draft.reviewer.mode === "fixed" ? "active" : ""} onClick={() => patch("reviewer", { mode: "fixed", provider: draft.provider, model: draft.model, thinking: "medium" })}>Separate model</button></div>
        {draft.reviewer.mode === "fixed" && <><label>Provider<input value={draft.reviewer.provider || ""} onChange={(event) => patch("reviewer", { ...draft.reviewer, provider: event.target.value })} /></label><label>Model<input value={draft.reviewer.model || ""} onChange={(event) => patch("reviewer", { ...draft.reviewer, model: event.target.value })} /></label></>}
      </section>
      <section id="settings-advanced" className="settings-card"><header><div><span className="setting-icon"><Check size={18} /></span><div><h2>Git remote publishing</h2><p>Administrators explicitly allow tag publication. Pull remains disabled.</p></div></div></header>
        <label><input type="checkbox" checked={draft.remotePublish.enabled} onChange={(event) => patch("remotePublish", { ...draft.remotePublish, enabled: event.target.checked })} /> Enable remote tag publishing</label>
        <label>Allowed remotes<input value={draft.remotePublish.allowedRemotes.join(", ")} onChange={(event) => patch("remotePublish", { ...draft.remotePublish, allowedRemotes: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label>
        <small>Publishes the approved source commit as a tag. It does not upload the formal package.</small>
      </section>
      <section id="settings-runtime" className="settings-card wide runtime-card"><header><div><span className="setting-icon"><Wrench size={18} /></span><div><h2>Engineering runtime</h2><p>WSL keeps the authority sidecar and CAD tools isolated from the desktop.</p></div></div><button className="icon-text" onClick={() => void check()}><RefreshCw size={14} />Check again</button></header>
        <label>Windows WSL distribution<input value={draft.distro} onChange={(event) => patch("distro", event.target.value)} /></label>
        <div className="dependency-list">{runtime.checks.map((item) => <div key={item.id}><span className={`dependency-state ${item.status}`}>{item.status === "ready" ? <Check size={13} /> : "!"}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div><span>{item.status}</span></div>)}</div>
        {runtime.state === "error" && <div className="runtime-action"><p>{runtime.message}</p><button className="primary" onClick={() => void window.piCad.runtime.install().then(setRuntime)}>Install missing dependencies<ChevronRight size={15} /></button></div>}
      </section>
      {installation && <section className="settings-card wide"><header><div><span className="setting-icon"><RefreshCw size={18} /></span><div><h2>Installation and updates</h2><p>Reify {installation.version} · {installation.platform}/{installation.arch} · {installation.channel}</p></div></div></header><p>{installation.updateInstructions}</p><small>User data: {installation.userDataPath}</small><small>Project: {installation.projectPath || "not selected"}</small><small>Updates are manual and must wait until active Agent work is stopped. Uninstalling the app does not delete either location.</small></section>}
    </div>
  </div>;
}
