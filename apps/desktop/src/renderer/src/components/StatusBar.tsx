import { useEffect, useState } from "react";
import { Box, Braces, GitBranch, ShieldCheck } from "./icons";
import type { AppSettings, RuntimeStatus } from "@shared/contracts";

function kernelLabel(status: RuntimeStatus): string {
  switch (status.state) {
    case "ready":
    case "streaming": return "Ready";
    case "starting": return "Starting";
    case "waiting_provider": return "Waiting for model";
    case "running": return "Working";
    case "retrying": return status.turn?.retry?.attempt ? `Retrying ${status.turn.retry.attempt}` : "Retrying";
    case "stopping": return "Stopping";
    case "aborted": return "Stopped";
    case "failed": return "Failed";
    default: return status.state;
  }
}

export function StatusBar({ settings, status }: { settings: AppSettings; status: RuntimeStatus }) {
  const [phase, setPhase] = useState("Not started");
  useEffect(() => {
    let active = false;
    const refresh = async () => {
      if (active) return;
      active = true;
      try {
        const value = await window.piCad.workflow.current();
        setPhase(value.phase?.replaceAll("_", " ") || "Not started");
      } catch {} finally { active = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, []);
  return <footer className="status-bar">
    <div><Box size={15} />{settings.provider} <span>·</span> {settings.model} <span>·</span> {settings.thinking}</div>
    <div><Braces size={15} />Kernel <b>{kernelLabel(status)}</b></div>
    <div><GitBranch size={15} />Workflow <b>{phase}</b></div>
    <div><ShieldCheck size={15} />Reviewer <b>{settings.reviewer.mode === "inherit" ? "Inherit" : settings.reviewer.model}</b></div>
    <div className="token-meter">Tokens <b>—</b></div>
  </footer>;
}
