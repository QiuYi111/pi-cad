import { Box, Braces, GitBranch, ShieldCheck } from "./icons";
import type { AppSettings, RuntimeStatus } from "@shared/contracts";

export function StatusBar({ settings, status }: { settings: AppSettings; status: RuntimeStatus }) {
  const [phase, setPhase] = useState("Not started");
  useEffect(() => {
    const refresh = () => window.piCad.workflow.current().then((value) => setPhase(value.phase?.replaceAll("_", " ") || "Not started")).catch(() => undefined);
    void refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => window.clearInterval(timer);
  }, []);
  return <footer className="status-bar">
    <div><Box size={15} />{settings.provider} <span>·</span> {settings.model} <span>·</span> {settings.thinking}</div>
    <div><Braces size={15} />Kernel <b>{status.state === "ready" || status.state === "streaming" ? "Ready" : status.state}</b></div>
    <div><GitBranch size={15} />Workflow <b>{phase}</b></div>
    <div><ShieldCheck size={15} />Reviewer <b>{settings.reviewer.mode === "inherit" ? "Inherit" : settings.reviewer.model}</b></div>
    <div className="token-meter">Tokens <b>—</b></div>
  </footer>;
}
import { useEffect, useState } from "react";
