import { useEffect, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal, Play, Plus, Share2 } from "../components/icons";
import type { AppSettings, TraceSummary } from "@shared/contracts";
import type { PrimeRuntimeController } from "../hooks/usePrimeRuntime";
import { Conversation } from "../components/Conversation";
import { Composer } from "../components/Composer";
import { WorkflowRail } from "../components/WorkflowRail";
import { EngineeringViewer } from "../components/EngineeringViewer";
import { StatusBar } from "../components/StatusBar";

export function Workbench({ settings, prime, onSettingsChange, onOpenSettings }: { settings: AppSettings; prime: PrimeRuntimeController; onSettingsChange: (settings: AppSettings) => void; onOpenSettings: () => void }) {
  const [chatWidth, setChatWidth] = useState(460);
  const [projectMenu, setProjectMenu] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectError, setProjectError] = useState("");
  const [sessionMenu, setSessionMenu] = useState(false);
  const [sessions, setSessions] = useState<TraceSummary[]>([]);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [ratingQuality, setRatingQuality] = useState(4);
  const [ratingDifficulty, setRatingDifficulty] = useState(3);
  const [ratingFeedback, setRatingFeedback] = useState("");
  const [ratingMessage, setRatingMessage] = useState("");
  const [ratingBusy, setRatingBusy] = useState(false);
  const workflowState = useRef<{ initialized: boolean; terminal: boolean; runId?: string }>({ initialized: false, terminal: false });
  const project = settings.projectPath.split(/[\\/]/).filter(Boolean).at(-1) || "Untitled project";
  const currentArtifact = [...prime.messages].reverse().find((message) => message.activity?.kind === "build" && message.activity.state === "success" && message.activity.artifactPath)?.activity?.artifactPath;
  const viewerRevision = prime.messages.filter((message) => message.activity?.state === "success" && (message.activity.kind === "build" || message.activity.kind === "simulation")).length;
  const start = async () => {
    if (!settings.projectPath) { onOpenSettings(); throw new Error("Choose a project folder before starting Prime."); }
    await prime.start();
  };
  const send = async (text: string, images?: Array<{ data: string; mimeType: string }>) => {
    const needsStart = prime.status.state !== "ready" && prime.status.state !== "streaming";
    await prime.prompt(text, images, needsStart ? start : undefined);
  };
  const updateSettings = async (patch: Partial<AppSettings>) => onSettingsChange(await window.piCad.settings.update(patch));
  const activateProject = async (path: string) => {
    await prime.stop();
    prime.clearConversation();
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
  const openSessions = async () => {
    const open = !sessionMenu;
    setSessionMenu(open);
    if (open) setSessions(await window.piCad.traces.list());
  };
  const newSession = async () => {
    if (prime.status.state !== "ready") await start();
    await prime.newSession();
    setSessionMenu(false);
  };
  const switchSession = async (path: string) => {
    if (prime.status.state === "streaming" || prime.status.state === "starting") throw new Error("Stop the current response before switching sessions.");
    if (prime.status.state !== "ready") await start();
    await prime.switchSession(path);
    setSessionMenu(false);
  };
  const rateCurrent = async () => {
    setRatingBusy(true);
    setRatingMessage("Saving rating and preparing the trajectory…");
    try {
      const available = await window.piCad.traces.list();
      const current = available.find((item) => item.id === prime.status.sessionId) || available[0];
      if (!current) { setRatingMessage("No saved conversation yet."); return; }
      const result = await window.piCad.traces.rate([current.path], { quality: ratingQuality, difficulty: ratingDifficulty, feedback: ratingFeedback });
      setRatingMessage(result.message);
    } catch (error) { setRatingMessage(`Rating failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setRatingBusy(false); }
  };
  useEffect(() => {
    workflowState.current = { initialized: false, terminal: false };
    let alive = true;
    const refresh = async (event?: any) => {
      const inner = event?.type === "session_event" ? event.event : event;
      if (inner && inner.type !== "tool_execution_end" && inner.type !== "agent_end") return;
      try {
        const current = await window.piCad.workflow.current();
        if (!alive) return;
        const terminal = current?.status === "done" || current?.phases?.some((phase) => phase.status === "active" && phase.id === "done") === true;
        const previous = workflowState.current;
        if (shouldOpenWorkflowRating(previous, { terminal, runId: current?.runId })) {
          setRatingMessage("");
          setRatingOpen(true);
        }
        workflowState.current = { initialized: true, terminal, runId: current?.runId };
      } catch { /* The workflow rail reports availability separately. */ }
    };
    void refresh();
    const unsubscribe = window.piCad.runtime.onEvent((event) => { void refresh(event); });
    return () => { alive = false; unsubscribe(); };
  }, [settings.projectPath, prime.status.sessionId]);
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
      <header className="chat-header"><strong>{project}</strong><span /><button className="rate-current" onClick={() => setRatingOpen((open) => !open)}>Rate</button><button aria-label="New conversation" title="New conversation" onClick={() => void newSession()}><Plus size={18} /></button><button aria-label="Conversations" title="Conversations" onClick={() => void openSessions()}><MoreHorizontal size={18} /></button>{ratingOpen && <div className="conversation-rating"><strong>Rate this conversation</strong><div className="rating-row"><label>Quality<select value={ratingQuality} onChange={(event) => setRatingQuality(Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option key={value}>{value}</option>)}</select></label><label>Difficulty<select value={ratingDifficulty} onChange={(event) => setRatingDifficulty(Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option key={value}>{value}</option>)}</select></label></div><textarea value={ratingFeedback} onChange={(event) => setRatingFeedback(event.target.value)} placeholder="What worked or failed?" /><button className="primary" disabled={ratingBusy} onClick={() => void rateCurrent()}>{ratingBusy ? "Saving…" : "Save rating"}</button>{ratingMessage && <small>{ratingMessage}</small>}</div>}{sessionMenu && <div className="session-menu"><button className="session-new" onClick={() => void newSession()}><Plus size={15} />New conversation</button><div className="session-list">{sessions.length ? sessions.map((session) => <button key={session.path} onClick={() => void switchSession(session.path)}><strong>{session.title}</strong><small>{new Date(session.updatedAt).toLocaleString()} · {session.evaluation ? `${session.evaluation.quality}/5` : "Unrated"}</small></button>) : <p>No previous conversations</p>}</div></div>}</header>
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
      <EngineeringViewer key={`${settings.projectPath}:${prime.status.sessionId || "none"}`} projectPath={settings.projectPath} latestArtifact={currentArtifact} revision={viewerRevision} />
    </section>
    <StatusBar settings={settings} status={prime.status} />
  </div>;
}

export function shouldOpenWorkflowRating(
  previous: { initialized: boolean; terminal: boolean; runId?: string },
  current: { terminal: boolean; runId?: string },
): boolean {
  return previous.initialized && !previous.terminal && current.terminal && Boolean(current.runId) && current.runId === previous.runId;
}
