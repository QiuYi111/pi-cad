import { useEffect, useState } from "react";
import { Boxes, FolderOpen, GitBranch, History, Plus, Settings2 } from "./components/icons";
import type { AppSettings } from "@shared/contracts";
import { Workbench } from "./pages/Workbench";
import { WorkflowEditor } from "./pages/WorkflowEditor";
import { Traces } from "./pages/Traces";
import { Settings } from "./pages/Settings";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { FirstRun } from "./pages/FirstRun";
import { usePrimeRuntime } from "./hooks/usePrimeRuntime";
import { BrandMark, Wordmark } from "./components/Brand";

type Page = "workbench" | "workflow" | "traces" | "settings";

export function App() {
  const [page, setPage] = useState<Page>("workbench");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [setupComplete, setSetupComplete] = useState(() => localStorage.getItem("pi-cad.setup-complete") === "1");
  const [projectMenu, setProjectMenu] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectError, setProjectError] = useState("");
  const prime = usePrimeRuntime();
  useEffect(() => { void window.piCad.settings.get().then(setSettings); }, []);
  if (!settings) return <div className="boot-screen"><BrandMark size={42} />Loading Reify</div>;
  if (!setupComplete && !settings.onboardingComplete) return <FirstRun settings={settings} onSettings={setSettings} onComplete={() => setSetupComplete(true)} />;

  const nav = [
    ["workbench", Boxes, "Workbench"],
    ["workflow", GitBranch, "Workflows"],
    ["traces", History, "Trajectories"],
    ["settings", Settings2, "Settings"],
  ] as const;

  const activateProject = async (path: string) => {
    if (prime.status.state === "streaming" || prime.status.state === "starting") { setProjectError("Stop the current task before switching projects."); return; }
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

  return <div className="app-shell">
    <header className="app-titlebar">
      <Wordmark />
      <nav aria-label="Application sections">
        {nav.map(([id, Icon, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)} aria-label={label}><Icon size={16} /><span>{label}</span></button>)}
      </nav>
      <button className="titlebar-project" aria-expanded={projectMenu} onClick={() => setProjectMenu((open) => !open)} title={settings.projectPath || "Choose a project"}>{settings.projectPath ? settings.projectPath.split(/[\\/]/).filter(Boolean).at(-1) : "Choose project"}</button>
      {projectMenu && <aside className="global-project-menu"><small>ACTIVE PROJECT</small><strong>{settings.projectPath || "No project selected"}</strong><button onClick={() => void chooseProject()}><FolderOpen size={14} />Open project</button><label><span>New project</span><input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createProject(); }} placeholder="Project name" /></label><button disabled={!projectName.trim()} onClick={() => void createProject()}><Plus size={14} />Create in folder…</button>{projectError && <p role="alert">{projectError}</p>}</aside>}
    </header>
    <main className="page-host">
      {page === "workbench" && <Workbench settings={settings} prime={prime} onSettingsChange={setSettings} onOpenSettings={() => setPage("settings")} />}
      {page === "workflow" && <WorkflowEditor />}
      {page === "traces" && <Traces />}
      {page === "settings" && <Settings value={settings} onChange={async (next) => {
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
