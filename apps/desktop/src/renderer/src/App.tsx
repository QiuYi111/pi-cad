import { useEffect, useState } from "react";
import { Boxes, GitBranch, History, Settings2 } from "./components/icons";
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

  return <div className="app-shell">
    <header className="app-titlebar">
      <Wordmark />
      <nav aria-label="Application sections">
        {nav.map(([id, Icon, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)} aria-label={label}><Icon size={16} /><span>{label}</span></button>)}
      </nav>
      <button className="titlebar-project" onClick={() => setPage("workbench")} title={settings.projectPath || "Choose a project"}>{settings.projectPath ? settings.projectPath.split(/[\\/]/).filter(Boolean).at(-1) : "Choose project"}</button>
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
