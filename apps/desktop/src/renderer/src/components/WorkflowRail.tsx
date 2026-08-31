import { useCallback, useEffect, useState } from "react";
import { Check, Circle } from "./icons";
import type { WorkflowCurrent } from "@shared/contracts";

export function WorkflowRail() {
  const [current, setCurrent] = useState<WorkflowCurrent | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const refresh = useCallback(async () => {
    try { setCurrent(await window.piCad.workflow.current()); setUnavailable(false); }
    catch { setCurrent(null); setUnavailable(true); }
  }, []);
  useEffect(() => {
    let alive = true;
    const update = () => { if (alive) void refresh(); };
    void refresh();
    const unsubscribe = window.piCad.runtime.onEvent(update);
    window.addEventListener("focus", update);
    return () => { alive = false; unsubscribe(); window.removeEventListener("focus", update); };
  }, [refresh]);
  const phases = current?.phases ?? [];
  if (unavailable) return <div className="workflow-rail unavailable" data-testid="workflow-rail"><span>Workflow unavailable</span></div>;
  if (!current?.runId || phases.length === 0) return <div className="workflow-rail idle" data-testid="workflow-rail"><span>No active workflow</span></div>;
  return <div className="workflow-rail" data-testid="workflow-rail">
    {phases.map((phase, index) => <div className={`rail-step ${phase.status}`} key={phase.id} aria-current={phase.status === "active" ? "step" : undefined} title={[phase.purpose, ...phase.transitions.map((item) => `${item.event} → ${item.target}`)].filter(Boolean).join("\n")}>
      <span className="rail-node">{phase.status === "complete" ? <Check size={11} /> : <Circle size={8} fill={phase.status === "active" ? "currentColor" : "none"} />}</span>
      <span>{phase.title}</span>
      {index < phases.length - 1 && <span className="rail-line" />}
    </div>)}
  </div>;
}
