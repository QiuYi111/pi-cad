import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, FolderOpen, Wrench } from "../components/icons";
import type { AppSettings, AuthStatus, RuntimeStatus } from "@shared/contracts";

export function FirstRun({ settings, onSettings, onComplete }: { settings: AppSettings; onSettings: (value: AppSettings) => void; onComplete: () => void }) {
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: "checking", checks: [] });
  const [auth, setAuth] = useState<AuthStatus>({ provider: "openai-codex", state: "checking" });
  const [manual, setManual] = useState("");
  const [working, setWorking] = useState<"wsl" | "runtime" | "auth" | "project" | "">("");
  const wslMissing = runtime.checks.some((item) => item.id === "wsl" && item.status !== "ready");
  const runtimeReady = runtime.checks.length > 0 && runtime.checks.every((item) => item.status === "ready");
  const complete = runtimeReady && auth.state === "signed-in" && Boolean(settings.projectPath);
  const progress = useMemo(() => [runtimeReady, auth.state === "signed-in", Boolean(settings.projectPath)].filter(Boolean).length, [runtimeReady, auth.state, settings.projectPath]);

  const check = async () => {
    setRuntime({ state: "checking", checks: [], message: "Checking Windows and WSL…" });
    try { setRuntime(await window.piCad.runtime.check()); }
    catch (error) { setRuntime({ state: "error", checks: [], message: String(error) }); }
  };
  useEffect(() => {
    void check();
    void window.piCad.auth.status().then(setAuth).catch(() => setAuth({ provider: "openai-codex", state: "signed-out" }));
    const offAuth = window.piCad.auth.onStatus(setAuth);
    const offRuntime = window.piCad.runtime.onStatus(setRuntime);
    return () => { offAuth(); offRuntime(); };
  }, []);

  const installWsl = async () => {
    setWorking("wsl");
    try {
      const result = await window.piCad.runtime.installWsl();
      setRuntime(result);
      if (result.state === "checking") await check();
    }
    catch (error) { setRuntime({ state: "error", checks: [], message: String(error) }); }
    finally { setWorking(""); }
  };
  const installRuntime = async () => {
    setWorking("runtime");
    try { setRuntime(await window.piCad.runtime.install()); }
    catch (error) { setRuntime({ state: "error", checks: runtime.checks, message: String(error) }); }
    finally { setWorking(""); }
  };
  const login = async () => {
    setWorking("auth");
    try { setAuth(await window.piCad.auth.login()); }
    finally { setWorking(""); }
  };
  const chooseProject = async () => {
    setWorking("project");
    try {
      const projectPath = await window.piCad.settings.chooseProject();
      if (projectPath) onSettings(await window.piCad.settings.update({ projectPath }));
    } finally { setWorking(""); }
  };
  const finish = () => { localStorage.setItem("pi-cad.setup-complete", "1"); onComplete(); };

  return <main className="first-run">
    <header className="first-run-titlebar"><div className="wordmark"><span className="wordmark-glyph" />Pi-CAD</div><span>Setup</span></header>
    <section className="setup-stage">
      <div className={`setup-progress ${runtime.state === "installing" ? "indeterminate" : ""}`} aria-label={`Setup ${progress} of 3`}><i style={{ width: `${Math.min(100, ((progress + (runtimeReady ? 0 : runtime.progress || 0)) / 3) * 100)}%` }} /></div>
      <div className="setup-hero"><span>READY THE WORKBENCH</span><h1>One workspace.<br />Everything it needs.</h1><p>Pi-CAD prepares an isolated engineering runtime, connects your ChatGPT account, and opens a project.</p></div>
      <div className="setup-grid">
        <SetupCard index="01" title="Engineering runtime" ready={runtimeReady} active={!runtimeReady} icon={<Wrench size={17} />}>
          <p>{runtime.message || (runtimeReady ? "WSL and the bundled CAD runtime are ready." : "Checking WSL and bundled components.")}</p>
          {(runtime.state === "checking" || runtime.state === "installing") && <SetupMotion label={runtime.state === "installing" ? `Installing · ${runtime.elapsedSeconds || 0}s` : "Inspecting system"} />}
          {runtime.state === "action-required"
            ? <button className="setup-secondary" disabled={Boolean(working)} onClick={() => void check()}>{runtime.action === "restart-windows" ? "Check after restart" : "I initialized Ubuntu — check again"}</button>
            : wslMissing ? <button className="primary" disabled={Boolean(working)} onClick={() => void installWsl()}>{working === "wsl" ? "Waiting for Windows…" : "Install WSL and Ubuntu"}<ChevronRight size={14} /></button>
              : !runtimeReady && runtime.state !== "checking" && runtime.state !== "installing" ? <button className="primary" disabled={Boolean(working)} onClick={() => void installRuntime()}>{working === "runtime" ? "Preparing runtime…" : "Install bundled runtime"}<ChevronRight size={14} /></button> : null}
        </SetupCard>
        <SetupCard index="02" title="ChatGPT" ready={auth.state === "signed-in"} active={runtimeReady && auth.state !== "signed-in"} icon={<span className="provider-mark" />}>
          <p>{auth.message || (auth.state === "signed-in" ? "Connected through OpenAI Codex OAuth." : "Use your ChatGPT account. No API key required.")}</p>
          {auth.state !== "signed-in" && <button className="setup-secondary" disabled={!runtimeReady || Boolean(working)} onClick={() => void login()}>{working === "auth" || auth.state === "waiting" ? "Waiting for sign-in…" : "Sign in with ChatGPT"}</button>}
          {auth.input && <div className="setup-auth-input"><input value={manual} onChange={(event) => setManual(event.target.value)} placeholder={auth.input.kind === "text" ? auth.input.placeholder || "Paste redirect URL" : "Choose account in the opened browser"} /><button disabled={!manual.trim()} onClick={() => { void window.piCad.auth.submitManualCode(manual.trim()); setManual(""); }}>Continue</button></div>}
        </SetupCard>
        <SetupCard index="03" title="Project folder" ready={Boolean(settings.projectPath)} active={runtimeReady && auth.state === "signed-in" && !settings.projectPath} icon={<FolderOpen size={17} />}>
          <p>{settings.projectPath || "Choose where Pi-CAD may read and write design files."}</p>
          {!settings.projectPath && <button className="setup-secondary" disabled={!runtimeReady || Boolean(working)} onClick={() => void chooseProject()}>{working === "project" ? "Opening…" : "Choose project folder"}</button>}
        </SetupCard>
      </div>
      <footer className="setup-footer"><span>{complete ? "Workbench ready" : "Complete the active step to continue"}</span><button className="primary" disabled={!complete} onClick={finish}>Open Pi-CAD<ChevronRight size={14} /></button></footer>
    </section>
  </main>;
}

function SetupCard({ index, title, ready, active, icon, children }: { index: string; title: string; ready: boolean; active: boolean; icon: React.ReactNode; children: React.ReactNode }) {
  return <article className={`setup-card ${ready ? "ready" : active ? "active" : "pending"}`}><header><span>{index}</span><i>{ready ? <Check size={14} /> : icon}</i></header><h2>{title}</h2><div>{children}</div></article>;
}

function SetupMotion({ label }: { label: string }) {
  return <div className="setup-motion"><span>{label}</span><div>{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</div></div>;
}
