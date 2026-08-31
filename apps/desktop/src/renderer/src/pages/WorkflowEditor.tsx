import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, FileCode2, GitBranch, Plus, Save } from "../components/icons";
import type { WorkflowDocument, WorkflowPhase } from "@shared/contracts";

export function WorkflowEditor() {
  const [documents, setDocuments] = useState<WorkflowDocument[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [source, setSource] = useState("");
  const [selectedPhase, setSelectedPhase] = useState<string>("");
  const [message, setMessage] = useState("");
  useEffect(() => { void window.piCad.workflow.list().then((items) => { setDocuments(items); setSelectedId(items[0]?.id || ""); setSource(items[0]?.raw || ""); setSelectedPhase(items[0]?.phases[0]?.id || ""); }); }, []);
  const document = useMemo(() => documents.find((item) => item.id === selectedId), [documents, selectedId]);
  const phase = document?.phases.find((item) => item.id === selectedPhase);
  const selectDocument = (next: WorkflowDocument) => { setSelectedId(next.id); setSource(next.raw || ""); setSelectedPhase(next.phases[0]?.id || ""); setMessage(""); };
  const createWorkflow = () => {
    const id = "custom.workflow";
    const raw = `schema: 1\nid: ${id}\ndescription: A project workflow.\ntags: [custom]\nversion: 1.0.0\nworkflow:\n  schema: 1\n  id: ${id}\n  version: 1.0.0\n  parametersSchema: {type: object, additionalProperties: false}\n  initialPhase: work\n  phases:\n    work:\n      purpose: Complete the project-specific work.\n      actions: [transition]\n      grants: [file_read, transition]\n      writeScopes: []\n      recordObligations: []\n      evidenceObligations: []\n      contextProviders: [kernel.current-action]\n      hooks: []\n      transitions: {finished: {target: done}}\n    done:\n      purpose: Preserve the completed result.\n      actions: []\n      grants: [file_read]\n      writeScopes: []\n      recordObligations: []\n      evidenceObligations: []\n      contextProviders: [kernel.current-action]\n      hooks: []\n      transitions: {}\n      terminal: true\n`;
    const draft: WorkflowDocument = { id, version: "1.0.0", description: "A project workflow.", raw, phases: [{ id: "work", title: "Work", purpose: "Complete the project-specific work.", status: "active", transitions: [{ event: "finished", target: "done" }], capabilities: ["transition"], obligations: [] }, { id: "done", title: "Done", purpose: "Preserve the completed result.", status: "pending", transitions: [], capabilities: [], obligations: [] }] };
    setDocuments((items) => [...items.filter((item) => item.sourcePath || item.id !== id), draft]);
    selectDocument(draft);
  };
  const save = async () => {
    if (!document) return;
    try {
      const saved = await window.piCad.workflow.save({ ...document, raw: source });
      setDocuments((items) => [...items.filter((item) => item.id !== selectedId && item.id !== saved.id), saved]); setSelectedId(saved.id); setSelectedPhase(saved.phases[0]?.id || ""); setSource(saved.raw || ""); setMessage("Saved and validated");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="workflow-editor" data-testid="workflow-editor">
    <aside className="workflow-library"><header><div><span>Workflows</span><h2>Installed packages</h2></div><button aria-label="New workflow" onClick={createWorkflow}><Plus size={16} /></button></header>{documents.map((item) => <button className={item.id === selectedId ? "active" : ""} key={item.id} onClick={() => selectDocument(item)}><GitBranch size={16} /><div><strong>{item.id}</strong><span>v{item.version}</span><p>{item.description}</p></div><ChevronRight size={15} /></button>)}</aside>
    <section className="workflow-canvas"><header><div><span>Workflow package</span><h1>{document?.id || "Loading…"}</h1></div><div className="editor-actions">{message && <span className={message.startsWith("Saved") ? "save-ok" : "save-error"}>{message}</span>}<button className="primary" onClick={() => void save()}><Save size={15} />Save workflow</button></div></header>
      <div className="phase-map">{document?.phases.map((item, index) => <div className="phase-map-entry" key={item.id}><button className={item.id === selectedPhase ? "active" : ""} onClick={() => setSelectedPhase(item.id)}><span>{index + 1}</span><div><strong>{item.title}</strong><small>{item.obligations.length} obligations · {item.capabilities.length} actions</small></div></button>{index < document.phases.length - 1 && <i />}</div>)}</div>
      <div className="phase-detail"><section><span>Purpose</span><h2>{phase?.title}</h2><p>{phase?.purpose}</p><h3>Allowed actions</h3><div className="tag-row">{phase?.capabilities.map((item) => <span key={item}>{item}</span>)}</div><h3>Required records and evidence</h3>{phase?.obligations.length ? <ul>{phase.obligations.map((item) => <li key={item}><Check size={13} />{item}</li>)}</ul> : <p className="muted">No obligations in this phase.</p>}<h3>Transitions</h3>{phase?.transitions.map((item) => <div className="transition-row" key={item.event}><code>{item.event}</code><ChevronRight size={13} /><strong>{item.target}</strong></div>)}</section>
        <section className="yaml-editor"><header><FileCode2 size={15} />Package YAML<span>{document?.sourcePath}</span></header><textarea value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} aria-label="Workflow YAML" /></section></div>
    </section>
  </div>;
}
