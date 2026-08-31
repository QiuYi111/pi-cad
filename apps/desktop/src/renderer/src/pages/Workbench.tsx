import { useState } from "react";
import { ChevronDown, MoreHorizontal, Play, Share2 } from "../components/icons";
import type { AppSettings } from "@shared/contracts";
import { usePrimeRuntime } from "../hooks/usePrimeRuntime";
import { Conversation } from "../components/Conversation";
import { Composer } from "../components/Composer";
import { WorkflowRail } from "../components/WorkflowRail";
import { CadViewer } from "../components/CadViewer";
import { StatusBar } from "../components/StatusBar";

export function Workbench({ settings, onSettingsChange, onOpenSettings }: { settings: AppSettings; onSettingsChange: (settings: AppSettings) => void; onOpenSettings: () => void }) {
  const prime = usePrimeRuntime();
  const [chatWidth, setChatWidth] = useState(460);
  const [projectMenu, setProjectMenu] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectError, setProjectError] = useState("");
  const project = settings.projectPath.split(/[\\/]/).filter(Boolean).at(-1) || "Untitled project";
  const currentArtifact = [...prime.messages].reverse().find((message) => message.activity?.kind === "build" && message.activity.state === "success" && message.activity.artifactPath)?.activity?.artifactPath;
  const start = async () => {
    if (!settings.projectPath) { onOpenSettings(); return; }
    await prime.start();
  };
  const send = async (text: string, images?: Array<{ data: string; mimeType: string }>) => {
    if (prime.status.state !== "ready" && prime.status.state !== "streaming") await start();
    await prime.prompt(text, images);
  };
  const updateSettings = async (patch: Partial<AppSettings>) => onSettingsChange(await window.piCad.settings.update(patch));
  const activateProject = async (path: string) => {
    await prime.stop();
    await updateSettings({ projectPath: path });
    setProjectMenu(false);
    setNewProject(false);
  };
  const switchProject = async () => {
    const path = await window.piCad.settings.chooseProject();
    if (path) await activateProject(path);
  };
  const createProject = async () => {
    setProjectError("");
    try {
      const path = await window.piCad.settings.createProject(projectName);
      if (path) { setProjectName(""); await activateProject(path); }
    } catch (error) { setProjectError(error instanceof Error ? error.message : String(error)); }
  };
  const resizeChat = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const shell = event.currentTarget.parentElement;
    if (!shell) return;
    const bounds = shell.getBoundingClientRect();
    const move = (next: PointerEvent) => setChatWidth(Math.max(320, Math.min(620, next.clientX - bounds.left)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("resizing-pane");
    };
    document.body.classList.add("resizing-pane");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };
  return <div className="workbench-page" style={{ "--chat-width": `${chatWidth}px` } as React.CSSProperties}>
    <section className="chat-pane">
      <header className="chat-header"><strong>{project}</strong><span /><button><MoreHorizontal size={18} /></button></header>
      <Conversation messages={prime.messages} />
      <Composer settings={settings} status={prime.status} onSettingsChange={updateSettings} onSend={send} onAbort={prime.abort} />
    </section>
    <div className="pane-resizer" role="separator" aria-label="调整对话区宽度" onPointerDown={resizeChat}><i /></div>
    <section className="design-pane">
      <header className="design-header">
        <div className="project-switcher">
          <button className="project-select" onClick={() => setProjectMenu((open) => !open)}>{project}<ChevronDown size={14} /></button>
          {projectMenu && <div className="project-menu">
            {!newProject ? <><button onClick={() => void switchProject()}>Open folder…</button><button onClick={() => setNewProject(true)}>New project…</button><button onClick={onOpenSettings}>Project settings</button></> : <form onSubmit={(event) => { event.preventDefault(); void createProject(); }}>
              <label>Project name<input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="My design" /></label>
              {projectError && <small>{projectError}</small>}
              <div><button type="button" onClick={() => { setNewProject(false); setProjectError(""); }}>Back</button><button className="primary" disabled={!projectName.trim()} type="submit">Choose location</button></div>
            </form>}
          </div>}
        </div>
        <button className="model-status"><i />Model status: Live<ChevronDown size={14} /></button>
        <span />
        {prime.status.state === "idle" || prime.status.state === "error" ? <button className="start-runtime" onClick={() => void start()}><Play size={14} fill="currentColor" />Start</button> : null}
        <button className="share-button"><Share2 size={15} />Share</button>
      </header>
      <WorkflowRail />
      <CadViewer artifactPath={currentArtifact} />
    </section>
    <StatusBar settings={settings} status={prime.status} />
  </div>;
}
