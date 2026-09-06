import { useEffect, useState } from "react";
import type { ParaViewSession, SimulationMetadata, ViewerSource } from "@shared/contracts";
import { Maximize2, TriangleAlert, Waves } from "./icons";

export function simulationStaleReason(metadata: SimulationMetadata | null, currentModel?: Extract<ViewerSource, { kind: "cad" }>): string {
  const provenance = modelIdentity(metadata?.modelSource);
  const currentPath = currentModel?.path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!metadata || !currentModel) return "";
  if (!provenance) return "The result does not record its CAD source.";
  if (provenance.path !== currentPath && !currentPath?.endsWith(`/${provenance.path}`)) return `Result uses ${provenance.path}; current model is ${currentPath}.`;
  if (provenance.sha256 && currentModel.sha256 && provenance.sha256 !== currentModel.sha256) return `CAD hash changed from ${provenance.sha256.slice(0, 10)} to ${currentModel.sha256.slice(0, 10)}.`;
  return "";
}

function modelIdentity(value?: string | null) {
  if (!value) return null;
  const [path, sha256] = value.split("#", 2);
  return { path: path!.replaceAll("\\", "/").replace(/^\.\//, ""), sha256: sha256 || "" };
}

export function ParaViewFrame({ source, currentModel, onRerun }: { source: Extract<ViewerSource, { kind: "simulation" }>; currentModel?: Extract<ViewerSource, { kind: "cad" }>; onRerun?: (request: string) => void }) {
  const [session, setSession] = useState<ParaViewSession>({ state: "starting", sourcePath: source.path });
  const [metadata, setMetadata] = useState<SimulationMetadata | null>(null);
  const [metadataError, setMetadataError] = useState("");
  useEffect(() => {
    let active = true;
    setSession({ state: "starting", sourcePath: source.path });
    setMetadata(null); setMetadataError("");
    void window.piCad.viewer.inspectSimulation(source.path).then((value) => { if (active) setMetadata(value); }).catch((error) => { if (active) setMetadataError(String(error)); });
    void window.piCad.viewer.openParaView(source.path).then((value) => { if (active) setSession(value); });
    return () => { active = false; };
  }, [source.path]);
  const staleReason = simulationStaleReason(metadata, currentModel);
  const provenancePanel = <aside className={`simulation-provenance ${staleReason ? "stale" : "current"}`}>
    <strong>{staleReason ? "Recompute required" : "Result matches current CAD"}</strong>
    <small>{staleReason || `Source · ${metadata?.modelSource || "reading…"}`}</small>
    <span>Display controls only change this view. Material, loads, constraints and mesh require a new run.</span>
    {staleReason && <button onClick={() => onRerun?.(`Re-run structural analysis for the current CAD model ${currentModel?.path}${currentModel?.sha256 ? ` (SHA-256 ${currentModel.sha256})` : ""}. Preserve the previous result ${source.path} as historical evidence, reuse its analysis configuration, and produce a new version-bound result.`)}>Re-run on current model</button>}
  </aside>;
  if (session.state === "ready" && session.url?.startsWith("http")) {
    return <section className="paraview-frame">
      <iframe src={session.url} title={`ParaView · ${source.label}`} allow="cross-origin-isolated" />
      <aside className="simulation-facts"><strong>{source.label}</strong><span>{metadata?.format || source.outputType} · {metadata ? `${metadata.pointCount} points · ${metadata.cellCount} cells` : "Reading fields…"}</span>{metadata?.fields.map((field) => <small key={`${field.association}:${field.name}`}>{field.name} · {field.min ?? "—"}–{field.max ?? "—"}{field.unit ? ` ${field.unit}` : " · unit unknown"}</small>)}<small>{metadata?.modelSource ? `Model · ${metadata.modelSource}` : "Model source · unknown"}</small>{metadataError && <small className="error">Metadata unavailable · {metadataError}</small>}</aside>
      {provenancePanel}
      <button className="paraview-desktop" onClick={() => void window.piCad.viewer.openParaViewDesktop(source.path)}><Maximize2 size={14} />Full ParaView</button>
    </section>;
  }
  if (session.state === "ready") return <section className="paraview-demo"><Waves size={38} /><strong>{source.label}</strong><span>ParaView session ready</span>{metadata?.fields.map((field) => <small key={field.name}>{field.name} · {field.min}–{field.max} {field.unit || "unit unknown"}</small>)}<small>{metadata?.modelSource ? `Model · ${metadata.modelSource}` : "Model source · unknown"}</small>{provenancePanel}</section>;
  if (session.state === "error") return <section className="viewer-empty"><span className="viewer-empty-mark"><TriangleAlert size={26} /></span><strong>Simulation view unavailable</strong><p>{session.message}</p><button onClick={() => void window.piCad.viewer.openParaViewDesktop(source.path)}><Maximize2 size={14} />Open full ParaView</button></section>;
  return <section className="paraview-demo loading"><Waves size={38} /><strong>Opening simulation…</strong><span>{source.label}</span></section>;
}
