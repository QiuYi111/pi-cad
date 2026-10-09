import { useEffect, useState } from "react";
import { Boxes, FolderOpen, GitBranch, History, Plus, Settings2 } from "./components/icons";
import { runtimeTurnActive, type AppSettings } from "@shared/contracts";
import { Workbench } from "./pages/Workbench";
import { WorkflowEditor } from "./pages/WorkflowEditor";
import { Traces } from "./pages/Traces";
import { Settings } from "./pages/Settings";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { FirstRun } from "./pages/FirstRun";
import { CloudLogin } from "./pages/CloudLogin";
import { CloudProjects } from "./pages/CloudProjects";
import { CloudNotices } from "./components/CloudNotices";
import { usePrimeRuntime } from "./hooks/usePrimeRuntime";
import { useCloud } from "./hooks/useCloud";
import { cloudErrorMessage } from "./lib/cloud-state";
import { BrandMark, Wordmark } from "./components/Brand";

type Page = "workbench" | "workflow" | "traces" | "settings" | "projects";

export function App() {
  const [page, setPage] = useState<Page>("workbench");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [setupComplete, setSetupComplete] = useState(() => localStorage.getItem("pi-cad.setup-complete") === "1");
  const [projectMenu, setProjectMenu] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectError, setProjectError] = useState("");
  const [cloudError, setCloudError] = useState("");
  const [cloudProjectName, setCloudProjectName] = useState("");
  const prime = usePrimeRuntime();
  const cloud = useCloud();
  useEffect(() => { void window.piCad.settings.get().then(setSettings); }, []);

  const cloudMode = settings?.mode === "cloud";
  const cloudProjectId = settings?.cloud?.projectId;
  const signedIn = cloud.view.status?.signedIn === true;
  // Opening a cloud project starts its workspace, so the runtime has somewhere to run.
  useEffect(() => {
    if (!cloudMode || !cloudProjectId || !signedIn) return;
    setCloudError("");
    void window.piCad.cloud.workspaceStart().then(cloud.setStatus, (error: unknown) => setCloudError(cloudErrorMessage(error)));
  }, [cloudMode, cloudProjectId, signedIn]);
  useEffect(() => {
    if (!cloudMode || !cloudProjectId || !signedIn) { setCloudProjectName(""); return; }
    void window.piCad.cloud.projects().then((projects) => setCloudProjectName(projects.find((item) => item.id === cloudProjectId)?.name ?? ""), () => setCloudProjectName(""));
  }, [cloudMode, cloudProjectId, signedIn]);

  if (!settings) return <div className="boot-screen"><BrandMark size={42} />Loading Reify</div>;
  if (!setupComplete && !settings.onboardingComplete) return <FirstRun settings={settings} onSettings={setSettings} onComplete={() => setSetupComplete(true)} />;
  if (cloudMode && !cloud.view.status) return <div className="boot-screen"><BrandMark size={42} />Loading Reify</div>;
  if (cloudMode && cloud.view.status && !cloud.view.status.signedIn) return <CloudLogin baseUrl={cloud.view.status.baseUrl} onSignedIn={cloud.setStatus} />;

  const nav: Array<[Page, typeof Boxes, string]> = [
    ["workbench", Boxes, "Workbench"],
    ...(cloudMode ? [["projects", FolderOpen, "Projects"] as [Page, typeof Boxes, string]] : []),
    ["workflow", GitBranch, "Workflows"],
    ["traces", History, "Trajectories"],
    ["settings", Settings2, "Settings"],
  ];
  // Cloud mode needs a project before anything else; settings stay reachable.
  const activePage: Page = cloudMode && !cloudProjectId && page !== "settings" ? "projects" : page;

  const activateProject = async (path: string) => {
    if (runtimeTurnActive(prime.status) || prime.status.state === "starting") { setProjectError("Stop the current task before switching projects."); return; }
    await prime.stop();
    prime.clearConversation();
    setSettings(await window.piCad.settings.update({ projectPath: path }));
    setProjectMenu(false);
    setProjectError("");
  };
  const chooseProject = async () => {
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
  const selectCloudProject = async () => {
    await prime.stop();
    prime.clearConversation();
    setSettings(await window.piCad.settings.get());
    setPage("workbench");
  };
  const retryWorkspaceStart = async () => {
    cloud.setStatus(await window.piCad.cloud.workspaceStart());
  };
  const reconnectCloud = async () => {
    await prime.stop();
    cloud.setStatus(await window.piCad.cloud.workspaceStart());
    await prime.start();
  };

  return <div className="app-shell">
    <header className="app-titlebar">
      <Wordmark />
      <nav aria-label="Application sections">
        {nav.map(([id, Icon, label]) => <button key={id} className={activePage === id ? "active" : ""} onClick={() => setPage(id)} aria-label={label}><Icon size={16} /><span>{label}</span></button>)}
      </nav>
      {cloudMode
        ? <button className="titlebar-project" onClick={() => setPage("projects")} title="Cloud project">{cloudProjectName || "Choose cloud project"}</button>
        : <button className="titlebar-project" aria-expanded={projectMenu} onClick={() => setProjectMenu((open) => !open)} title={settings.projectPath || "Choose a project"}>{settings.projectPath ? settings.projectPath.split(/[\\/]/).filter(Boolean).at(-1) : "Choose project"}</button>}
      {!cloudMode && projectMenu && <aside className="global-project-menu"><small>ACTIVE PROJECT</small><strong>{settings.projectPath || "No project selected"}</strong><button onClick={() => void chooseProject()}><FolderOpen size={14} />Open project</button><label><span>New project</span><input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createProject(); }} placeholder="Project name" /></label><button disabled={!projectName.trim()} onClick={() => void createProject()}><Plus size={14} />Create in folder…</button>{projectError && <p role="alert">{projectError}</p>}</aside>}
    </header>
    {cloudMode && <CloudNotices view={cloud.view} onDismiss={cloud.dismiss} onReconnect={reconnectCloud} onRetryStart={retryWorkspaceStart} />}
    {cloudError && <div className="cloud-banner" role="alert">{cloudError}</div>}
    <main className="page-host">
      {activePage === "workbench" && <Workbench settings={settings} prime={prime} cloudWorkspaceState={cloudMode ? cloud.view.status?.workspace.state : undefined} onSettingsChange={setSettings} onOpenSettings={() => setPage("settings")} />}
      {activePage === "projects" && <CloudProjects selectedId={cloudProjectId} view={cloud.view} onSelected={() => void selectCloudProject()} />}
      {activePage === "workflow" && <WorkflowEditor />}
      {activePage === "traces" && <Traces cloudMode={cloudMode} />}
      {activePage === "settings" && <Settings value={settings} onChange={async (next) => {
        if (next.projectPath !== settings.projectPath) {
          await prime.stop();
          prime.clearConversation();
        }
        setSettings(next);
      }} />}
    </main>
    <ExtensionDialog />
  </div>;
}
