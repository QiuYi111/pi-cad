import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Check, ChevronDown, FolderOpen, Play, Plus, Search, ShieldCheck } from "../components/icons";
import type { AppSettings, MeshDocument, TraceSummary } from "@shared/contracts";
import type { PrimeRuntimeController } from "../hooks/usePrimeRuntime";
import { Conversation } from "../components/Conversation";
import { Composer } from "../components/Composer";
import { WorkflowRail } from "../components/WorkflowRail";
import { EngineeringViewer } from "../components/EngineeringViewer";
import { StatusBar } from "../components/StatusBar";
import { ConceptBoard, type ConceptImage, type ConceptSelection } from "../components/ConceptBoard";
import { automaticConversationTitle, needsAutomaticConversationTitle } from "../lib/conversation-title";

export function Workbench({ settings, prime, onSettingsChange, onOpenSettings }: { settings: AppSettings; prime: PrimeRuntimeController; onSettingsChange: (settings: AppSettings) => void; onOpenSettings: () => void }) {
  const [projectMenu, setProjectMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem("reify.sidebar-open.v1") !== "0");
  const [newProject, setNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectError, setProjectError] = useState("");
  const [sessions, setSessions] = useState<TraceSummary[]>([]);
  const [sessionsState, setSessionsState] = useState<"loading" | "ready" | "error">("loading");
  const sessionRequest = useRef(0);
  const sessionsProject = useRef("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [recentProjects, setRecentProjects] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("reify.recent-projects.v1") || "[]");
      return Array.isArray(saved) ? saved.filter((path): path is string => typeof path === "string").slice(0, 6) : [];
    } catch { return []; }
  });
  const [sessionAliases, setSessionAliases] = useState<Record<string, string>>({});
  const [renamingSession, setRenamingSession] = useState("");
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const pendingAutomaticTitle = useRef("");
  const [conversationStorageKey, setConversationStorageKey] = useState(() => localStorage.getItem(`reify.active-conversation-key.${settings.projectPath || "unconfigured"}`) || crypto.randomUUID());
  const [ratingOpen, setRatingOpen] = useState(false);
  const [ratingQuality, setRatingQuality] = useState(4);
  const [ratingDifficulty, setRatingDifficulty] = useState(3);
  const [ratingFeedback, setRatingFeedback] = useState("");
  const [ratingMessage, setRatingMessage] = useState("");
  const [ratingBusy, setRatingBusy] = useState(false);
  const [mode, setMode] = useState<"conversation" | "canvas">("conversation");
  const composerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean } | null>(null);
  const composerPositionRef = useRef({ x: 0.5, y: 0.82 });
  const composerClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerPositionKey = "reify.composer-position.v2";
  const [composerPosition, setComposerPosition] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("reify.composer-position.v2") || "null");
      if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) return { x: saved.x, y: saved.y };
    } catch { /* Restore the safe default below. */ }
    return { x: 0.5, y: 0.82 };
  });
  useEffect(() => { composerPositionRef.current = composerPosition; }, [composerPosition]);
  useEffect(() => () => { if (composerClickTimer.current) clearTimeout(composerClickTimer.current); }, []);
  const [hasDraft, setHasDraft] = useState(false);
  const [readingHistory, setReadingHistory] = useState(false);
  const [canvasNotice, setCanvasNotice] = useState(false);
  const [canvasNoticeTarget, setCanvasNoticeTarget] = useState<"artifact" | "concept" | null>(null);
  useEffect(() => {
    if (mode !== "canvas" || !canvasNotice) return;
    setCanvasNotice(false);
    setCanvasNoticeTarget(null);
  }, [mode, canvasNotice]);
  const [canvasContent, setCanvasContent] = useState<"concept" | "artifact">("artifact");
  const canvasContentRef = useRef(canvasContent);
  const [uploadedConcepts, setUploadedConcepts] = useState<ConceptImage[]>([]);
  const [openedMesh, setOpenedMesh] = useState<MeshDocument | null>(null);
  const openedMeshRef = useRef<MeshDocument | null>(null);
  const [openStepState, setOpenStepState] = useState<"idle" | "loading">("idle");
  const [openStepError, setOpenStepError] = useState("");
  const restoringWorkspace = useRef(false);
  const lastPresentedArtifact = useRef("");
  const workflowState = useRef<{ initialized: boolean; terminal: boolean; runId?: string }>({ initialized: false, terminal: false });
  const project = settings.projectPath.split(/[\\/]/).filter(Boolean).at(-1) || "Untitled project";
  const workspaceStateKey = `reify.workspace.${settings.projectPath || "unconfigured"}`;
  const artifactStateKey = `reify.artifact.${settings.projectPath || "unconfigured"}`;
  const sessionAliasKey = `reify.session-aliases.${settings.projectPath || "unconfigured"}`;
  const conversationKeyStateKey = `reify.active-conversation-key.${settings.projectPath || "unconfigured"}`;
  useEffect(() => {
    setConversationStorageKey(localStorage.getItem(conversationKeyStateKey) || crypto.randomUUID());
  }, [conversationKeyStateKey]);
  useEffect(() => { localStorage.setItem(conversationKeyStateKey, conversationStorageKey); }, [conversationKeyStateKey, conversationStorageKey]);
  useEffect(() => {
    const id = prime.status.sessionId;
    if (id && !conversationStorageKey.includes(id)) setConversationStorageKey(id);
  }, [conversationStorageKey, prime.status.sessionId]);
  const visibleSessions = useMemo(() => {
    const needle = sessionQuery.trim().toLowerCase();
    return needle ? sessions.filter((session) => `${sessionAliases[session.path] || session.title} ${session.model}`.toLowerCase().includes(needle)) : sessions;
  }, [sessions, sessionAliases, sessionQuery]);
  const otherProjects = useMemo(() => recentProjects.filter((path) => path !== settings.projectPath), [recentProjects, settings.projectPath]);
  const builtArtifact = [...prime.messages].reverse().find((message) => message.activity?.kind === "build" && message.activity.state === "success" && message.activity.artifactPath)?.activity?.artifactPath;
  const currentArtifact = openedMesh?.source || builtArtifact;
  const buildRevision = prime.messages.filter((message) => message.activity?.kind === "build" && message.activity.state === "success").length;
  const generatedConcepts = useMemo(() => prime.messages.flatMap((message) => message.activity?.kind === "image" && message.activity.state === "success"
    ? (message.activity.media || []).filter((media) => Boolean(media.dataUrl)).map((media) => ({ ...media, version: 0, origin: "generated" as const }))
    : []), [prime.messages]);
  const presentedConceptCount = useRef(generatedConcepts.length);
  const conceptImages = useMemo(() => [...uploadedConcepts, ...generatedConcepts].map((image, index) => ({ ...image, version: index + 1 })), [uploadedConcepts, generatedConcepts]);
  const toolMedia = useMemo(() => prime.messages.flatMap((message) => message.activity?.state === "success" ? message.activity.media || [] : []), [prime.messages]);
  const hasCanvasContent = Boolean(currentArtifact || conceptImages.length);
  const viewerRevision = prime.messages.filter((message) => message.activity?.state === "success" && (message.activity.kind === "build" || message.activity.kind === "simulation")).length;
  const successfulChecks = prime.messages.filter((message) => message.activity?.state === "success" && ["probe", "review", "simulation"].includes(message.activity.kind)).length;
  const latestFailure = [...prime.messages].reverse().find((message) => message.activity?.state === "failed" || message.activity?.state === "denied");
  const latestBuildIndex = prime.messages.reduce((last, message, index) => message.activity?.kind === "build" && message.activity.state === "success" ? index : last, -1);
  const latestReviewIndex = prime.messages.reduce((last, message, index) => message.activity?.kind === "review" && message.activity.state === "success" ? index : last, -1);
  const reviewPassed = latestReviewIndex >= 0 && latestReviewIndex > latestBuildIndex;
  const modelName = currentArtifact?.split(/[\\/]/).at(-1) || "No model yet";
  const missingProject = prime.status.message?.startsWith("Project folder no longer exists") ?? false;
  const start = async () => {
    if (!settings.projectPath) { onOpenSettings(); throw new Error("Choose a project folder before starting Prime."); }
    await prime.start();
  };
  const send = async (text: string, images?: Array<{ data: string; mimeType: string }>) => {
    if (!prime.messages.some((message) => message.role === "user")) pendingAutomaticTitle.current = automaticConversationTitle(text);
    const needsStart = prime.status.state !== "ready" && prime.status.state !== "streaming";
    await prime.prompt(text, images, needsStart ? start : undefined);
  };
  useEffect(() => { canvasContentRef.current = canvasContent; }, [canvasContent]);
  useEffect(() => { openedMeshRef.current = openedMesh; }, [openedMesh]);
  const updateSettings = async (patch: Partial<AppSettings>) => onSettingsChange(await window.piCad.settings.update(patch));
  const rememberProject = (path: string) => setRecentProjects((current) => {
    const next = [path, ...current.filter((item) => item !== path)].slice(0, 6);
    localStorage.setItem("reify.recent-projects.v1", JSON.stringify(next));
    return next;
  });
  useEffect(() => {
    if (!settings.projectPath) return;
    setRecentProjects((current) => {
      const next = [settings.projectPath, ...current.filter((item) => item !== settings.projectPath)].slice(0, 6);
      localStorage.setItem("reify.recent-projects.v1", JSON.stringify(next));
      return next;
    });
  }, [settings.projectPath]);
  const activateProject = async (path: string) => {
    if (prime.status.state === "streaming" || prime.status.state === "starting") {
      setProjectError("One Agent task can run at a time. Stop the current task before switching projects.");
      return;
    }
    await prime.stop();
    prime.clearConversation();
    setOpenedMesh(null);
    setUploadedConcepts([]);
    setOpenStepError("");
    setMode("conversation");
    lastPresentedArtifact.current = "";
    await updateSettings({ projectPath: path });
    rememberProject(path);
    setProjectMenu(false);
    setNewProject(false);
  };
  useEffect(() => {
    restoringWorkspace.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(workspaceStateKey) || "null");
      if (saved?.mode === "conversation" || saved?.mode === "canvas") setMode(saved.mode);
      if (saved?.canvasContent === "concept" || saved?.canvasContent === "artifact") setCanvasContent(saved.canvasContent);
    } catch { /* Ignore obsolete local UI state. */ }
  }, [workspaceStateKey]);
  useEffect(() => {
    if (restoringWorkspace.current) { restoringWorkspace.current = false; return; }
    localStorage.setItem(workspaceStateKey, JSON.stringify({ mode, canvasContent }));
  }, [workspaceStateKey, mode, canvasContent]);
  useEffect(() => {
    if (currentArtifact) localStorage.setItem(artifactStateKey, currentArtifact);
  }, [artifactStateKey, currentArtifact]);
  useEffect(() => {
    if (currentArtifact) return;
    const saved = localStorage.getItem(artifactStateKey);
    if (!saved) return;
    let alive = true;
    void window.piCad.viewer.loadStep(saved).then((mesh) => {
      if (alive) setOpenedMesh(mesh);
    }).catch(() => localStorage.removeItem(artifactStateKey));
    return () => { alive = false; };
  }, [artifactStateKey]);
  useEffect(() => {
    if (currentArtifact || !settings.projectPath || localStorage.getItem(artifactStateKey)) return;
    let alive = true;
    void window.piCad.viewer.catalog().then(async (catalog) => {
      const artifacts = [...(catalog.currentRun?.artifacts || []), ...catalog.projectHead.artifacts];
      const artifact = artifacts.find((item) => /\.(?:step|stp)$/i.test(item.path));
      if (!artifact) return;
      const mesh = await window.piCad.viewer.loadStep(artifact.path);
      if (!alive || mesh.sha256 !== artifact.sha256) return;
      setOpenedMesh(mesh);
      setCanvasContent("artifact");
      let savedMode = "";
      try { savedMode = JSON.parse(localStorage.getItem(workspaceStateKey) || "null")?.mode || ""; } catch { /* Ignore obsolete state. */ }
      if (savedMode !== "conversation") setMode("canvas");
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [artifactStateKey, currentArtifact, settings.projectPath]);
  const switchProject = async () => {
    const path = await window.piCad.settings.chooseProject();
    if (path) await activateProject(path);
  };
  const openStep = async () => {
    const path = await window.piCad.viewer.chooseStep();
    if (!path) return;
    setOpenStepState("loading");
    setOpenStepError("");
    try {
      const mesh = await window.piCad.viewer.loadStep(path);
      setOpenedMesh(mesh);
      lastPresentedArtifact.current = `${mesh.source}:opened`;
      setCanvasContent("artifact");
      setMode("canvas");
    } catch (error) {
      setOpenStepError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpenStepState("idle");
    }
  };
  const createProject = async () => {
    setProjectError("");
    try {
      const path = await window.piCad.settings.createProject(projectName);
      if (path) { setProjectName(""); await activateProject(path); }
    } catch (error) { setProjectError(error instanceof Error ? error.message : String(error)); }
  };
  const refreshSessions = async (showLoading = true) => {
    const request = ++sessionRequest.current;
    if (showLoading) setSessionsState("loading");
    try {
      const next = await window.piCad.traces.list();
      if (request !== sessionRequest.current) return;
      setSessions(next);
      setSessionsState("ready");
    } catch {
      if (request === sessionRequest.current && showLoading) setSessionsState("error");
    }
  };
  useEffect(() => {
    if (sessionsProject.current !== settings.projectPath) {
      sessionsProject.current = settings.projectPath;
      setSessions([]);
    }
    void refreshSessions();
    return () => { sessionRequest.current += 1; };
  }, [settings.projectPath, prime.status.sessionId]);
  useEffect(() => {
    if (!pendingAutomaticTitle.current || !prime.status.sessionId) return;
    void refreshSessions(false);
  }, [prime.messages.length, prime.status.sessionId, prime.status.state]);
  useEffect(() => {
    try { setSessionAliases(JSON.parse(localStorage.getItem(sessionAliasKey) || "{}")); }
    catch { setSessionAliases({}); }
  }, [sessionAliasKey]);
  useEffect(() => {
    const title = pendingAutomaticTitle.current;
    if (!title || !prime.status.sessionId) return;
    const session = sessions.find((item) => item.id === prime.status.sessionId);
    if (!session || sessionAliases[session.path] || !needsAutomaticConversationTitle(session.title, session.id)) return;
    setSessionAliases((current) => {
      if (current[session.path]) return current;
      const next = { ...current, [session.path]: title };
      localStorage.setItem(sessionAliasKey, JSON.stringify(next));
      return next;
    });
    pendingAutomaticTitle.current = "";
  }, [prime.status.sessionId, sessionAliasKey, sessionAliases, sessions]);
  const saveSessionTitle = (path: string) => {
    const title = sessionTitleDraft.trim();
    if (!title) return;
    setSessionAliases((current) => {
      const next = { ...current, [path]: title };
      localStorage.setItem(sessionAliasKey, JSON.stringify(next));
      return next;
    });
    setRenamingSession("");
  };
  const newSession = async () => {
    if (prime.status.state === "streaming" || prime.status.state === "starting") throw new Error("Stop the current response before starting another conversation.");
    setConversationStorageKey(crypto.randomUUID());
    setOpenedMesh(null);
    setUploadedConcepts([]);
    setOpenStepError("");
    if (prime.status.state === "ready") await prime.newSession();
    else prime.clearConversation();
    await refreshSessions();
  };
  const switchSession = async (path: string) => {
    if (prime.status.state === "streaming" || prime.status.state === "starting") throw new Error("Stop the current response before switching sessions.");
    setConversationStorageKey(path);
    setOpenedMesh(null);
    setUploadedConcepts([]);
    setOpenStepError("");
    if (prime.status.state !== "ready") await start();
    await prime.switchSession(path);
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
  useEffect(() => {
    const presentationKey = builtArtifact ? `${builtArtifact}:${buildRevision}` : "";
    if (!builtArtifact || presentationKey === lastPresentedArtifact.current) return;
    lastPresentedArtifact.current = presentationKey;
    if (openedMeshRef.current) { setCanvasNoticeTarget("artifact"); setCanvasNotice(true); return; }
    setOpenedMesh(null);
    const selectedText = Boolean(window.getSelection()?.toString().trim());
    if (hasDraft || readingHistory || selectedText) { setCanvasNoticeTarget("artifact"); setCanvasNotice(true); }
    else if (mode === "canvas" && canvasContentRef.current === "concept") { setCanvasNoticeTarget("artifact"); setCanvasNotice(true); }
    else { setCanvasContent("artifact"); setMode("canvas"); }
  }, [builtArtifact, buildRevision, hasDraft, readingHistory, mode]);
  useEffect(() => {
    if (generatedConcepts.length <= presentedConceptCount.current) return;
    presentedConceptCount.current = generatedConcepts.length;
    if (mode === "canvas") {
      if (canvasContentRef.current === "artifact") { setCanvasNoticeTarget("concept"); setCanvasNotice(true); }
      return;
    }
    if (!hasDraft && !readingHistory && !window.getSelection()?.toString().trim()) { setCanvasContent("concept"); setMode("canvas"); }
    else { setCanvasNoticeTarget("concept"); setCanvasNotice(true); }
  }, [generatedConcepts.length, hasDraft, readingHistory, mode]);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "\\") return;
      event.preventDefault();
      if (!hasCanvasContent) { setMode("conversation"); return; }
      setMode((current) => current === "conversation" ? "canvas" : "conversation");
      setCanvasNotice(false);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [hasCanvasContent]);
  const addUploadedConcepts = (images: Array<{ name: string; data: string; mimeType: string }>) => {
    if (!images.length) return;
    setUploadedConcepts((current) => [...current, ...images.map((image) => ({ id: crypto.randomUUID(), role: "Uploaded concept", label: image.name, dataUrl: `data:${image.mimeType};base64,${image.data}`, mimeType: image.mimeType, version: 0, origin: "uploaded" as const }))]);
    setCanvasContent("concept");
    setMode("canvas");
  };
  const continueFromConcept = async (image: ConceptImage, note: string, selection?: ConceptSelection) => {
    const region = selection ? `Selected normalized region x=${selection.x.toFixed(3)}, y=${selection.y.toFixed(3)}, width=${selection.width.toFixed(3)}, height=${selection.height.toFixed(3)}.` : "Use the full image.";
    const text = `Continue the design from concept V${image.version} (${image.label || image.role}). ${region}${note.trim() ? ` Design note: ${note.trim()}` : ""} Preserve this image/version reference in the design rationale.`;
    const match = image.dataUrl?.match(/^data:([^;]+);base64,(.+)$/s);
    await send(text, match ? [{ mimeType: match[1]!, data: match[2]! }] : undefined);
  };
  const clampComposer = (position: { x: number; y: number }) => {
    const box = composerRef.current?.getBoundingClientRect();
    if (!box || !innerWidth || !innerHeight) return { x: .5, y: .82 };
    const marginX = Math.min(.46, (box.width / 2 + 18) / innerWidth);
    const marginTop = Math.min(.82, (box.height / 2 + 70) / innerHeight);
    const marginBottom = Math.min(.82, (box.height / 2 + 54) / innerHeight);
    return { x: Math.max(marginX, Math.min(1 - marginX, position.x)), y: Math.max(marginTop, Math.min(1 - marginBottom, position.y)) };
  };
  const saveComposerPosition = (position: { x: number; y: number }) => {
    const next = clampComposer(position);
    setComposerPosition(next);
    try { localStorage.setItem(composerPositionKey, JSON.stringify(next)); }
    catch { /* Position persistence is optional; dragging must still work. */ }
  };
  const resetComposerPosition = () => {
    localStorage.removeItem(composerPositionKey);
    setComposerPosition(clampComposer({ x: .5, y: .82 }));
  };
  const beginComposerDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: composerPosition.x, y: composerPosition.y, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveComposer = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) setComposerPosition(clampComposer({ x: drag.x + dx / innerWidth, y: drag.y + dy / innerHeight }));
  };
  const endComposerDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    if (drag.moved) saveComposerPosition(composerPositionRef.current);
    else if (hasCanvasContent) {
      if (composerClickTimer.current) clearTimeout(composerClickTimer.current);
      composerClickTimer.current = setTimeout(() => {
        setMode((current) => current === "conversation" ? "canvas" : "conversation");
        composerClickTimer.current = null;
      }, 220);
    }
  };
  useEffect(() => {
    const keepVisible = () => setComposerPosition((current) => clampComposer(current));
    window.addEventListener("resize", keepVisible);
    return () => window.removeEventListener("resize", keepVisible);
  }, []);
  const workbenchStyle = { "--composer-x": `${composerPosition.x * 100}%`, "--composer-y": `${composerPosition.y * 100}%` } as React.CSSProperties;
  return <div className={`workbench-page mode-${mode}`} style={workbenchStyle}>
    {canvasNotice && <button className="canvas-ready-notice" onClick={() => { if (canvasNoticeTarget === "artifact") { setOpenedMesh(null); setCanvasContent("artifact"); } else if (canvasNoticeTarget === "concept") setCanvasContent("concept"); setMode("canvas"); setCanvasNoticeTarget(null); setCanvasNotice(false); }}>New {canvasNoticeTarget === "concept" ? "concept" : "model"} ready · Open canvas</button>}
    {prime.status.state === "error" && <div className="runtime-recovery" role="alert"><strong>{missingProject ? "Project unavailable" : "Task was interrupted"}</strong><span>{prime.status.message || "The Agent runtime exited before completion."}</span>{missingProject ? <button onClick={onOpenSettings}>Choose project</button> : <><button onClick={() => void start()}>Retry runtime</button><button onClick={() => void send("Continue the interrupted task from the last durable project state.")}>Continue task</button></>}</div>}
    <section className={`chat-pane ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
      <aside className="conversation-sidebar" aria-label="Projects and conversations">
        <div className="sidebar-top"><button className="new-chat" onClick={() => void newSession()}><Plus size={16} />新对话</button><button className="sidebar-collapse" aria-label="收起侧栏" onClick={() => { setSidebarOpen(false); localStorage.setItem("reify.sidebar-open.v1", "0"); }}>‹</button></div>
        <div className="sidebar-group project-group"><span>项目</span><button className="sidebar-project" onClick={() => setProjectMenu((open) => !open)}><FolderOpen size={15} /><strong>{project}</strong><ChevronDown size={13} /></button>
          <div className="project-quick-actions"><button onClick={() => void switchProject()}>打开项目</button><button onClick={() => { setProjectMenu(true); setNewProject(true); }}>新建项目</button></div>
          {projectMenu && <div className="sidebar-project-menu">{projectError && <small role="alert">{projectError}</small>}{!newProject ? <><button onClick={() => void switchProject()}>打开项目</button><button onClick={() => setNewProject(true)}>新建项目</button><button onClick={onOpenSettings}>项目设置</button></> : <form onSubmit={(event) => { event.preventDefault(); void createProject(); }}><label>项目名称<input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="新设计" /></label><div><button type="button" onClick={() => setNewProject(false)}>返回</button><button className="primary" disabled={!projectName.trim()} type="submit">选择位置</button></div></form>}</div>}
          {!!otherProjects.length && <div className="recent-projects">{otherProjects.map((path) => <div key={path}><button title={path} onClick={() => void activateProject(path)}>{path.split(/[\\/]/).filter(Boolean).at(-1)}</button><button aria-label={`Remove ${path} from recent projects`} onClick={() => setRecentProjects((current) => { const next = current.filter((item) => item !== path); localStorage.setItem("reify.recent-projects.v1", JSON.stringify(next)); return next; })}>×</button></div>)}</div>}
        </div>
        <div className="sidebar-group chat-history"><span>对话</span><label className="sidebar-search"><Search size={13} /><input aria-label="搜索当前项目的对话" value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="搜索对话" />{sessionQuery && <button aria-label="清除搜索" onClick={() => setSessionQuery("")}>×</button>}</label><div className="sidebar-session-list">{sessionsState === "loading" ? <p>正在读取对话…</p> : sessionsState === "error" ? <p role="alert">无法读取对话。请重试或检查项目。</p> : visibleSessions.length ? visibleSessions.map((session) => <div className={`sidebar-session ${session.id === prime.status.sessionId ? "active" : ""}`} key={session.path}>{renamingSession === session.path ? <input aria-label={`Conversation title for ${session.title}`} autoFocus value={sessionTitleDraft} onChange={(event) => setSessionTitleDraft(event.target.value)} onBlur={() => saveSessionTitle(session.path)} onKeyDown={(event) => { if (event.key === "Enter") saveSessionTitle(session.path); if (event.key === "Escape") setRenamingSession(""); }} /> : <button title={`${sessionAliases[session.path] || session.title}；双击可改名`} onClick={() => void switchSession(session.path)} onDoubleClick={() => { setRenamingSession(session.path); setSessionTitleDraft(sessionAliases[session.path] || session.title); }}><strong>{sessionAliases[session.path] || session.title}</strong><small>{new Date(session.updatedAt).toLocaleDateString()}</small></button>}<button className="rename-session" title="重命名对话" aria-label={`Rename ${sessionAliases[session.path] || session.title}`} onClick={() => { setRenamingSession(session.path); setSessionTitleDraft(sessionAliases[session.path] || session.title); }}>改名</button></div>) : <p>{sessionQuery ? "没有匹配的对话。" : "完成第一条需求后，对话会出现在这里。"}</p>}</div></div>
        <button className="sidebar-settings" onClick={onOpenSettings}>设置</button>
      </aside>
      {!sidebarOpen && <button className="sidebar-reopen" aria-label="展开侧栏" onClick={() => { setSidebarOpen(true); localStorage.setItem("reify.sidebar-open.v1", "1"); }}>›</button>}
      <header className="chat-header"><div><small>Design agent</small><strong>{project}</strong></div><span /><button className="open-step" aria-label="Open STEP" disabled={openStepState === "loading"} onClick={() => void openStep()}><FolderOpen size={15} />{openStepState === "loading" ? "Opening…" : "Open STEP"}</button><button className="rate-current" onClick={() => setRatingOpen((open) => !open)}>Rate</button>{ratingOpen && <div className="conversation-rating"><strong>Rate this conversation</strong><div className="rating-row"><label>Quality<select value={ratingQuality} onChange={(event) => setRatingQuality(Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option key={value}>{value}</option>)}</select></label><label>Difficulty<select value={ratingDifficulty} onChange={(event) => setRatingDifficulty(Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option key={value}>{value}</option>)}</select></label></div><textarea value={ratingFeedback} onChange={(event) => setRatingFeedback(event.target.value)} placeholder="What worked or failed?" /><button className="primary" disabled={ratingBusy} onClick={() => void rateCurrent()}>{ratingBusy ? "Saving…" : "Save rating"}</button>{ratingMessage && <small>{ratingMessage}</small>}</div>}</header>
      {openStepError && <div className="conversation-error" role="alert"><strong>Could not open that STEP.</strong><span>{currentArtifact ? "The current model is preserved." : "Choose another project STEP file."}</span><small>{openStepError}</small></div>}
      <Conversation messages={prime.messages} onReadingChange={setReadingHistory} onReference={(text) => void send(text)} />
    </section>
    <section className="design-pane">
      <header className="design-header">
        <div className="project-switcher">
          <small>Current project</small><button className="project-select" onClick={() => setProjectMenu((open) => !open)}>{project}<ChevronDown size={14} /></button>
          {projectMenu && <div className="project-menu">
            {projectError && <small role="alert">{projectError}</small>}
            {!newProject ? <><button onClick={() => void switchProject()}>Open folder…</button><button onClick={() => setNewProject(true)}>New project…</button><button onClick={onOpenSettings}>Project settings</button></> : <form onSubmit={(event) => { event.preventDefault(); void createProject(); }}>
              <label>Project name<input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="My design" /></label>
              {projectError && <small>{projectError}</small>}
              <div><button type="button" onClick={() => { setNewProject(false); setProjectError(""); }}>Back</button><button className="primary" disabled={!projectName.trim()} type="submit">Choose location</button></div>
            </form>}
          </div>}
        </div>
        <div className="current-version"><Box size={14} /><span><small>Current model</small><strong>{modelName}</strong></span></div>
        {!!conceptImages.length && <div className="canvas-content-switch"><button className={canvasContent === "concept" ? "active" : ""} onClick={() => setCanvasContent("concept")}>Concepts</button><button className={canvasContent === "artifact" ? "active" : ""} disabled={!currentArtifact} onClick={() => setCanvasContent("artifact")}>Model</button></div>}
        <span />
        {prime.status.state === "idle" || prime.status.state === "error" ? <button className="start-runtime" onClick={() => void start()}><Play size={14} fill="currentColor" />Start</button> : null}
      </header>
      <WorkflowRail />
      {canvasContent === "artifact" && <section className="engineering-brief" aria-label="Engineering status">
        <div><span>Model version</span><strong>{viewerRevision ? `Build ${viewerRevision}` : "Not built"}</strong><small>{modelName}</small></div>
        <div><span>Checks</span><strong>{successfulChecks ? `${successfulChecks} passed` : "Pending"}</strong><small>Bound to current work</small></div>
        <div className={latestFailure ? "attention" : ""}><span>Attention</span><strong>{latestFailure ? "Action needed" : "No blocker"}</strong><small>{latestFailure?.activity?.title || "Ready to continue"}</small></div>
        <div><span>Review authority</span><strong>{reviewPassed ? "Machine review passed" : currentArtifact ? "Candidate ready" : "Not ready"}</strong><small>{reviewPassed ? <><ShieldCheck size={11} /> Bound to this candidate</> : currentArtifact ? <><ShieldCheck size={11} /> Machine review pending</> : <><Check size={11} /> Build first</>}</small></div>
      </section>}
      <div className={`canvas-layer artifact-layer ${canvasContent === "artifact" ? "active" : ""}`}><EngineeringViewer key={`${settings.projectPath}:${prime.status.sessionId || "none"}:${openedMesh?.source || "catalog"}`} projectPath={settings.projectPath} latestArtifact={currentArtifact} openedMesh={openedMesh} mediaArtifacts={toolMedia} revision={viewerRevision} agentRunning={prime.status.state === "streaming" || prime.status.state === "starting"} onStopAgent={() => void prime.abort()} onAskAgent={(request) => { setMode("conversation"); void send(request); }} /></div>
      {!!conceptImages.length && <div className={`canvas-layer concept-layer ${canvasContent === "concept" ? "active" : ""}`}><ConceptBoard images={conceptImages} onContinue={continueFromConcept} /></div>}
    </section>
    <div className="floating-composer" ref={composerRef}>
      <button className="composer-handle" aria-label={mode === "conversation" ? "切换到画布；拖动可移动输入框" : "展开对话；拖动可移动输入框"} aria-keyshortcuts="Control+Backslash Meta+Backslash" title="点击切换 · 拖动调整位置 · 双击复位" onPointerDown={beginComposerDrag} onPointerMove={moveComposer} onPointerUp={endComposerDrag} onPointerCancel={() => { dragRef.current = null; }} onLostPointerCapture={() => { dragRef.current = null; }} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); if (composerClickTimer.current) clearTimeout(composerClickTimer.current); composerClickTimer.current = null; resetComposerPosition(); }}><span /></button>
      <Composer settings={settings} status={prime.status} queueKey={`${settings.projectPath}:${conversationStorageKey}`} onSettingsChange={updateSettings} onSend={send} onNote={prime.note} onAbort={prime.abort} onDraftChange={setHasDraft} onImagesAdded={addUploadedConcepts} />
      <button className="composer-reset" onClick={resetComposerPosition}>复位输入框</button>
    </div>
    <StatusBar settings={settings} status={prime.status} />
  </div>;
}

export function shouldOpenWorkflowRating(
  previous: { initialized: boolean; terminal: boolean; runId?: string },
  current: { terminal: boolean; runId?: string },
): boolean {
  return previous.initialized && !previous.terminal && current.terminal && Boolean(current.runId) && current.runId === previous.runId;
}
