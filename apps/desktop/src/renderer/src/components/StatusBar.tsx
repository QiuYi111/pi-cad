import { useEffect, useState } from "react";
import { Box, Braces, GitBranch, ShieldCheck } from "./icons";
import type { AppSettings, RuntimeStatus } from "@shared/contracts";

/** Runtime phase text; the runtime already decided it, so no guessing here. */
export function phaseLabel(status: RuntimeStatus): string {
  switch (status.phase) {
    case "starting_turn": return "Starting turn";
    case "waiting_provider": return "Waiting for model";
    case "thinking": return "Thinking";
    case "responding": return "Responding";
    case "running_tool": return "Running tool";
    case "compacting": return "Compacting";
    case "retrying": return status.retry ? `Retrying ${status.retry.attempt}/${status.retry.maxAttempts}` : "Retrying";
    case "provider_wait": return "Waiting for provider";
    case "stalled": return "No provider response";
    case "stopping": return "Stopping";
    case "aborted": return "Stopped";
    case "reasoning_limit": return "Reasoning limit";
    case "provider_timeout": return "Provider timeout";
    case "rpc_timeout": return "Runtime RPC timeout";
    case "failed": return "Failed";
    case "ready": return status.state === "streaming" ? "Working" : "Ready";
    default: return status.state === "ready" || status.state === "streaming" ? "Ready" : status.state;
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
    <div><Braces size={15} />Kernel <b>{phaseLabel(status)}</b></div>
    <div><GitBranch size={15} />Workflow <b>{phase}</b></div>
    <div><ShieldCheck size={15} />Reviewer <b>{settings.reviewer.mode === "inherit" ? "Inherit" : settings.reviewer.model}</b></div>
    <div className="token-meter">Tokens <b>—</b></div>
  </footer>;
}
