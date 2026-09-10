import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, FolderOpen, Wrench } from "../components/icons";
import type { AppSettings, AuthStatus, RuntimeStatus } from "@shared/contracts";
import { Wordmark } from "../components/Brand";

export function setupErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/404|not found/i.test(text) && /node|nodejs/i.test(text)) return "Node.js 安装包下载失败。请检查网络后重试。";
  const lines = text
    .replace(/^Error:\s*/i, "")
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .split(/\r?\n/);
  const architecture = lines.find((line) => /^Unsupported WSL CPU architecture:\s*/i.test(line.trim()) && !line.includes("$picad_"));
  if (architecture) return `当前 WSL 处理器架构无法识别：${architecture.trim().replace(/^Unsupported WSL CPU architecture:\s*/i, "")}`;
  const clean = lines.find((line) => line.trim() && !/^(command failed:|picad_|case |curl\s|tar |ln |mkdir |export )/i.test(line.trim()));
  return (clean || "安装失败，请重试。").trim().slice(0, 220);
}

export function FirstRun({ settings, onSettings, onComplete }: { settings: AppSettings; onSettings: (value: AppSettings) => void; onComplete: () => void }) {
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: "checking", checks: [] });
  const [auth, setAuth] = useState<AuthStatus>({ provider: "openai-codex", state: "checking" });
  const [manual, setManual] = useState("");
  const [projectName, setProjectName] = useState("我的第一个设计");
  const [working, setWorking] = useState<"wsl" | "runtime" | "auth" | "project" | "">("");
  const setupAttempt = useRef("");
  const wslMissing = runtime.checks.some((item) => item.id === "wsl" && item.status !== "ready");
  const requiredIds = new Set(["host", "wsl", "node", "python", "uv", "sandbox", "bwrap", "prime", "picad"]);
  const requiredChecks = runtime.checks.filter((item) => requiredIds.has(item.id));
  const runtimeReady = requiredChecks.length > 0 && requiredChecks.every((item) => item.status === "ready");
  const complete = runtimeReady && auth.state === "signed-in" && Boolean(settings.projectPath);
  const progress = useMemo(() => [runtimeReady, auth.state === "signed-in", Boolean(settings.projectPath)].filter(Boolean).length, [runtimeReady, auth.state, settings.projectPath]);

  const check = async () => {
    setRuntime({ state: "checking", checks: [], message: "正在检查 Windows 和 WSL…" });
    try { setRuntime(await window.piCad.runtime.check()); }
    catch (error) { setRuntime({ state: "error", checks: [], message: setupErrorMessage(error) }); }
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
      if (result.action !== "restart-windows") await check();
    }
    catch (error) { setRuntime({ state: "error", checks: [], message: setupErrorMessage(error) }); }
    finally { setWorking(""); }
  };
  const installRuntime = async () => {
    setWorking("runtime");
    try { setRuntime(await window.piCad.runtime.install()); }
    catch (error) { setRuntime({ state: "error", checks: runtime.checks, message: setupErrorMessage(error) }); }
    finally { setWorking(""); }
  };
  const prepareEnvironment = () => {
    localStorage.setItem("reify.environment-setup-pending.v1", "1");
    setupAttempt.current = "";
    void (wslMissing ? installWsl() : installRuntime());
  };
  useEffect(() => {
    if (localStorage.getItem("reify.environment-setup-pending.v1") !== "1") return;
    if (runtimeReady) {
      localStorage.removeItem("reify.environment-setup-pending.v1");
      setupAttempt.current = "";
      return;
    }
    if (working || runtime.state === "checking" || runtime.state === "installing" || runtime.action === "restart-windows") return;
    const signature = `${runtime.state}:${runtime.action || ""}:${runtime.checks.map((item) => `${item.id}:${item.status}`).join(",")}`;
    if (setupAttempt.current === signature) return;
    setupAttempt.current = signature;
    void (wslMissing ? installWsl() : installRuntime());
  }, [runtime, runtimeReady, working, wslMissing]);
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
  const createProject = async () => { setWorking("project"); try { const projectPath = await window.piCad.settings.createProject(projectName.trim()); if (projectPath) onSettings(await window.piCad.settings.update({ projectPath })); } finally { setWorking(""); } };
  const finish = async () => { localStorage.setItem("pi-cad.setup-complete", "1"); onSettings(await window.piCad.settings.update({ onboardingComplete: true })); onComplete(); };

  return <main className="first-run">
    <header className="first-run-titlebar"><Wordmark /><span>首次设置</span></header>
    <section className="setup-stage">
      <div className={`setup-progress ${runtime.state === "installing" && runtime.progress === undefined ? "indeterminate" : ""}`} aria-label={`Setup ${progress} of 3`}><i style={{ width: `${Math.min(100, ((progress + (runtimeReady ? 0 : runtime.progress || 0)) / 3) * 100)}%` }} /></div>
      <div className="setup-hero"><span>MAKE IDEAS REAL</span><h1>把想法变成<br />可检查的工程成果。</h1><p>依次准备工程环境、连接 ChatGPT，并选择项目位置。中断后会从当前步骤继续。</p></div>
      <div className="setup-grid">
        <SetupCard index="01" title="工程环境" ready={runtimeReady} active={!runtimeReady} icon={<Wrench size={17} />}>
          <p>{runtime.message || (runtimeReady ? "WSL 和内置 CAD 环境已就绪。" : "正在检查 WSL 和内置组件。")}</p>
          <label>WSL 发行版<input value={settings.distro} onChange={(event) => onSettings({ ...settings, distro: event.target.value })} onBlur={() => void window.piCad.settings.update({ distro: settings.distro })} /></label>
          {runtime.state === "installing" && runtime.progress !== undefined
            ? <RuntimeProgress progress={runtime.progress} elapsedSeconds={runtime.elapsedSeconds || 0} />
            : runtime.state === "checking" || runtime.state === "installing" ? <SetupMotion label="正在检查系统" /> : null}
          {runtime.action === "restart-windows"
            ? <button className="primary" disabled={Boolean(working)} onClick={() => void window.piCad.runtime.restartWindows()}>重启并继续<ChevronRight size={14} /></button>
            : !runtimeReady && runtime.state !== "checking" && runtime.state !== "installing"
              ? <button className="primary" disabled={Boolean(working)} onClick={prepareEnvironment}>{working ? "正在准备…" : "准备工程环境"}<ChevronRight size={14} /></button>
              : null}
        </SetupCard>
        <SetupCard index="02" title="连接 ChatGPT" ready={auth.state === "signed-in"} active={runtimeReady && auth.state !== "signed-in"} icon={<span className="provider-mark" />}>
          <p>{auth.message || (auth.state === "signed-in" ? "ChatGPT 已连接。" : "使用 ChatGPT 账号登录，无需 API Key。")}</p>
          {auth.state !== "signed-in" && <span><button className="setup-secondary" disabled={!runtimeReady || Boolean(working)} onClick={() => void login()}>{working === "auth" || auth.state === "waiting" ? "等待浏览器登录…" : auth.state === "error" ? "重试登录" : "使用 ChatGPT 登录"}</button>{auth.state === "waiting" && <button onClick={() => void window.piCad.auth.cancel().then(setAuth)}>取消</button>}</span>}
          {auth.input && <div className="setup-auth-input"><input value={manual} onChange={(event) => setManual(event.target.value)} placeholder={auth.input.kind === "text" ? auth.input.placeholder || "粘贴浏览器返回地址" : "在浏览器选择账号"} /><button disabled={!manual.trim()} onClick={() => { void window.piCad.auth.submitManualCode(manual.trim()); setManual(""); }}>继续</button></div>}
        </SetupCard>
        <SetupCard index="03" title="项目位置" ready={Boolean(settings.projectPath)} active={runtimeReady && auth.state === "signed-in" && !settings.projectPath} icon={<FolderOpen size={17} />}>
          <p>{settings.projectPath || "选择 Reify 可以读写设计文件的位置。"}</p>
          {!settings.projectPath && <><label>新项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><span><button className="primary" disabled={!runtimeReady || Boolean(working) || !projectName.trim()} onClick={() => void createProject()}>创建项目</button><button className="setup-secondary" disabled={!runtimeReady || Boolean(working)} onClick={() => void chooseProject()}>{working === "project" ? "正在打开…" : "打开已有项目"}</button></span></>}
        </SetupCard>
      </div>
      <footer className="setup-footer"><span>{complete ? "工作区已就绪" : "完成当前步骤后继续"}</span><button className="primary" disabled={!complete} onClick={() => void finish()}>进入 Reify<ChevronRight size={14} /></button></footer>
    </section>
  </main>;
}

function SetupCard({ index, title, ready, active, icon, children }: { index: string; title: string; ready: boolean; active: boolean; icon: React.ReactNode; children: React.ReactNode }) {
  return <article className={`setup-card ${ready ? "ready" : active ? "active" : "pending"}`}><header><span>{index}</span><i>{ready ? <Check size={14} /> : icon}</i></header><h2>{title}</h2><div>{children}</div></article>;
}

function SetupMotion({ label }: { label: string }) {
  return <div className="setup-motion"><span>{label}</span><div>{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</div></div>;
}

function RuntimeProgress({ progress, elapsedSeconds }: { progress: number; elapsedSeconds: number }) {
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return <div className="runtime-install-progress" aria-label={`安装进度 ${percent}%`}>
    <div><strong>{percent}%</strong><span>已用 {elapsedSeconds} 秒</span></div>
    <progress max={1} value={progress} />
  </div>;
}
