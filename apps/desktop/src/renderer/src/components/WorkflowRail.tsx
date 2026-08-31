import { useEffect, useState } from "react";
import { Check, Circle } from "./icons";
import type { WorkflowCurrent, WorkflowPhase } from "@shared/contracts";

const fallback: WorkflowPhase[] = ["Grilling", "Spec", "Concept", "Parts", "Assembly", "Review", "Release"].map((title, index) => ({
  id: title.toLowerCase(), title, purpose: "", status: index === 0 ? "active" : "pending", transitions: [], capabilities: [], obligations: [],
}));

function project(phases: WorkflowPhase[], current: WorkflowCurrent): WorkflowPhase[] {
  const active = phases.findIndex((phase) => phase.id === current.phase);
  if (active < 0) return phases;
  return phases.map((phase, index) => ({ ...phase, status: index < active ? "complete" : index === active ? "active" : "pending" }));
}

export function WorkflowRail() {
  const [phases, setPhases] = useState(fallback);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [documents, current] = await Promise.all([window.piCad.workflow.list(), window.piCad.workflow.current()]);
        const document = documents.find((item) => item.id === current.workflowId) || documents[0];
        if (alive && document) setPhases(project(document.phases, current));
      } catch {}
    };
    void refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  return <div className="workflow-rail" data-testid="workflow-rail">
    {phases.map((phase, index) => <div className={`rail-step ${phase.status}`} key={phase.id}>
      <span className="rail-node">{phase.status === "complete" ? <Check size={11} /> : <Circle size={8} fill={phase.status === "active" ? "currentColor" : "none"} />}</span>
      <span>{phase.title}</span>
      {index < phases.length - 1 && <span className="rail-line" />}
    </div>)}
  </div>;
}
