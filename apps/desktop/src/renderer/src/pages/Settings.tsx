import { useEffect, useState } from "react";
import { Check, ChevronRight, FolderOpen, RefreshCw, Wrench } from "../components/icons";
import type { AppSettings, AuthStatus, RuntimeStatus, ThinkingLevel } from "@shared/contracts";

const levels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function Settings({ value, onChange }: { value: AppSettings; onChange: (value: AppSettings) => void }) {
  const [draft, setDraft] = useState(value);
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: "checking", checks: [] });
  const [saving, setSaving] = useState(false);
  const [auth, setAuth] = useState<AuthStatus>({ provider: "openai-codex", state: "checking" });
  const check = () => window.piCad.runtime.check().then(setRuntime).catch((error) => setRuntime({ state: "error", checks: [], message: String(error) }));
  useEffect(() => {
    void check();
    void window.piCad.auth.status().then(setAuth);
    return window.piCad.auth.onStatus(setAuth);
  }, []);
  const patch = <K extends keyof AppSettings>(key: K, next: AppSettings[K]) => setDraft((current) => ({ ...current, [key]: next }));
  const save = async () => { setSaving(true); try { const next = await window.piCad.settings.update(draft); onChange(next); setDraft(next); } finally { setSaving(false); } };
  const chooseProject = async () => { const path = await window.piCad.settings.chooseProject(); if (path) patch("projectPath", path); };
  return <div className="settings-page page-scroll" data-testid="settings-page">
    <header className="page-heading"><div><span>Preferences</span><h1>Providers and runtime</h1><p>Choose where engineering runs and which models make decisions.</p></div><button className="primary" onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</button></header>
    <div className="settings-grid">
      <section className="settings-card wide"><header><div><span className="setting-icon"><FolderOpen size={18} /></span><div><h2>Project</h2><p>Prime and Pi-CAD only receive this workspace.</p></div></div></header><div className="path-picker"><code>{draft.projectPath || "No project selected"}</code><button onClick={() => void chooseProject()}>Choose folder</button></div></section>
      <section className="settings-card"><header><div><span className="setting-icon blue"><span className="provider-mark" /></span><div><h2>Author model</h2><p>Used for design and engineering work.</p></div></div></header>
        <label>Provider<select value={draft.provider} onChange={(event) => patch("provider", event.target.value)}><option value="openai-codex">OpenAI Codex</option><option value="prime">Prime Inference</option><option value="zai">Z.AI</option><option value="openrouter">OpenRouter</option></select></label>
        <label>Default model<input value={draft.model} onChange={(event) => patch("model", event.target.value)} /></label>
        <label>Reasoning<select value={draft.thinking} onChange={(event) => patch("thinking", event.target.value as ThinkingLevel)}>{levels.map((level) => <option key={level}>{level}</option>)}</select></label>
        <div className="auth-row"><div><i className={auth.state === "signed-in" ? "online" : ""} /><span>{auth.message || auth.state}</span></div><button disabled={auth.state === "waiting"} onClick={() => void window.piCad.auth.login().then(setAuth)}>{auth.state === "signed-in" ? "Reconnect" : auth.state === "waiting" ? "Waiting…" : "Sign in with ChatGPT"}</button></div>
      </section>
      <section className="settings-card"><header><div><span className="setting-icon"><Check size={18} /></span><div><h2>Independent reviewer</h2><p>Defaults to the active author model.</p></div></div></header>
        <div className="segmented"><button className={draft.reviewer.mode === "inherit" ? "active" : ""} onClick={() => patch("reviewer", { mode: "inherit" })}>Inherit author</button><button className={draft.reviewer.mode === "fixed" ? "active" : ""} onClick={() => patch("reviewer", { mode: "fixed", provider: draft.provider, model: draft.model, thinking: "medium" })}>Separate model</button></div>
        {draft.reviewer.mode === "fixed" && <><label>Provider<input value={draft.reviewer.provider || ""} onChange={(event) => patch("reviewer", { ...draft.reviewer, provider: event.target.value })} /></label><label>Model<input value={draft.reviewer.model || ""} onChange={(event) => patch("reviewer", { ...draft.reviewer, model: event.target.value })} /></label></>}
      </section>
      <section className="settings-card wide runtime-card"><header><div><span className="setting-icon"><Wrench size={18} /></span><div><h2>Engineering runtime</h2><p>WSL keeps the authority sidecar and CAD tools isolated from the desktop.</p></div></div><button className="icon-text" onClick={() => void check()}><RefreshCw size={14} />Check again</button></header>
        <div className="dependency-list">{runtime.checks.map((item) => <div key={item.id}><span className={`dependency-state ${item.status}`}>{item.status === "ready" ? <Check size={13} /> : "!"}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div><span>{item.status}</span></div>)}</div>
        {runtime.state === "error" && <div className="runtime-action"><p>{runtime.message}</p><button className="primary" onClick={() => void window.piCad.runtime.install().then(setRuntime)}>Install missing dependencies<ChevronRight size={15} /></button></div>}
      </section>
    </div>
  </div>;
}
