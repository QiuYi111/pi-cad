import { useEffect, useState } from "react";
import { Boxes, GitBranch, History, Settings2 } from "./components/icons";
import type { AppSettings } from "@shared/contracts";
import { Workbench } from "./pages/Workbench";
import { WorkflowEditor } from "./pages/WorkflowEditor";
import { Traces } from "./pages/Traces";
import { Settings } from "./pages/Settings";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { FirstRun } from "./pages/FirstRun";

type Page = "workbench" | "workflow" | "traces" | "settings";

export function App() {
  const [page, setPage] = useState<Page>("workbench");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [setupComplete, setSetupComplete] = useState(() => localStorage.getItem("pi-cad.setup-complete") === "1");
  useEffect(() => { void window.piCad.settings.get().then(setSettings); }, []);
  if (!settings) return <div className="boot-screen"><div className="boot-mark" />Loading Pi-CAD</div>;
  if (!setupComplete) return <FirstRun settings={settings} onSettings={setSettings} onComplete={() => setSetupComplete(true)} />;

  const nav = [
    ["workbench", Boxes, "Workbench"],
    ["workflow", GitBranch, "Workflows"],
    ["traces", History, "Trajectories"],
    ["settings", Settings2, "Settings"],
  ] as const;

  return <div className="app-shell">
    <header className="app-titlebar">
      <div className="wordmark"><span className="wordmark-glyph" />Pi-CAD</div>
      <nav aria-label="Application sections">
        {nav.map(([id, Icon, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)} aria-label={label}><Icon size={16} /><span>{label}</span></button>)}
      </nav>
      <div className="titlebar-project">{settings.projectPath ? settings.projectPath.split(/[\\/]/).filter(Boolean).at(-1) : "No project"}</div>
    </header>
    <main className="page-host">
      {page === "workbench" && <Workbench key={settings.projectPath} settings={settings} onSettingsChange={setSettings} onOpenSettings={() => setPage("settings")} />}
      {page === "workflow" && <WorkflowEditor />}
      {page === "traces" && <Traces />}
      {page === "settings" && <Settings value={settings} onChange={setSettings} />}
    </main>
    <ExtensionDialog />
  </div>;
}
