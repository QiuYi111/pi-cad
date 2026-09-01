import { useEffect, useMemo, useState } from "react";
import type { ViewerCatalog, ViewerSource } from "@shared/contracts";
import { Boxes, GitBranch, RefreshCw, Waves } from "./icons";
import { CadViewer } from "./CadViewer";
import { ParaViewFrame } from "./ParaViewFrame";
import { preferredSource, sourcesFromCatalog } from "../lib/viewer-catalog";

const EMPTY: ViewerCatalog = { projectId: "", projectHead: { updatedAt: "", artifacts: [] }, currentRun: null, commits: [], simulationRuns: [] };

function Scene({ source }: { source?: ViewerSource }) {
  if (!source) return <CadViewer />;
  return source.kind === "cad" ? <CadViewer artifactPath={source.path} /> : <ParaViewFrame source={source} />;
}

function SourceSelect({ value, sources, onChange }: { value?: string; sources: ViewerSource[]; onChange: (value: string) => void }) {
  const cad = sources.filter((source) => source.kind === "cad");
  const simulations = sources.filter((source) => source.kind === "simulation");
  return <label className="viewer-source-select">
    {sources.find((source) => source.id === value)?.kind === "simulation" ? <Waves size={14} /> : <Boxes size={14} />}
    <select value={value || ""} onChange={(event) => onChange(event.target.value)} aria-label="Viewer source">
      {!sources.length && <option value="">No results</option>}
      {!!cad.length && <optgroup label="Models">{cad.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</optgroup>}
      {!!simulations.length && <optgroup label="Simulation">{simulations.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</optgroup>}
    </select>
  </label>;
}

export function EngineeringViewer({ projectPath, latestArtifact, revision }: { projectPath: string; latestArtifact?: string; revision: number }) {
  const [catalog, setCatalog] = useState<ViewerCatalog>(EMPTY);
  const [selected, setSelected] = useState("");
  const [compare, setCompare] = useState(false);
  const [secondary, setSecondary] = useState("");
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const sources = useMemo(() => sourcesFromCatalog(catalog, latestArtifact), [catalog, latestArtifact]);
  const primarySource = sources.find((source) => source.id === selected) ?? preferredSource(sources);
  const secondarySource = sources.find((source) => source.id === secondary) ?? sources.find((source) => source.id !== primarySource?.id);

  const refresh = async () => {
    if (!projectPath) return;
    setLoading(true); setCatalogError("");
    try { setCatalog(await window.piCad.viewer.catalog()); }
    catch (error) { setCatalogError(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [projectPath, revision]);
  useEffect(() => {
    if (!selected && sources.length) setSelected(preferredSource(sources)?.id ?? sources[0]!.id);
    if (selected && !sources.some((source) => source.id === selected)) setSelected(preferredSource(sources)?.id ?? sources[0]?.id ?? "");
  }, [sources, selected]);
  useEffect(() => {
    const open = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      const source = sources.find((item) => item.path === path);
      if (source) setSelected(source.id);
      void refresh();
    };
    window.addEventListener("pi-cad:open-viewer", open);
    return () => window.removeEventListener("pi-cad:open-viewer", open);
  }, [sources, projectPath]);

  return <section className={`engineering-viewer ${compare ? "comparing" : ""}`}>
    <header className="viewer-context-bar">
      <SourceSelect value={primarySource?.id} sources={sources} onChange={setSelected} />
      <span className="viewer-source-meta">{primarySource?.kind === "simulation" ? `${primarySource.outputType}${primarySource.unit ? ` · ${primarySource.unit}` : ""}` : primarySource ? primarySource.scope : "No active model"}</span>
      {catalogError && <span className="viewer-catalog-error" title={catalogError}>Catalog unavailable</span>}
      <button className={compare ? "active" : ""} onClick={() => setCompare((value) => !value)} disabled={sources.length < 2}><GitBranch size={14} />Compare</button>
      <button aria-label="Refresh viewer catalog" onClick={() => void refresh()} className={loading ? "spinning" : ""}><RefreshCw size={14} /></button>
    </header>
    {compare && <div className="compare-secondary-bar"><span>Against</span><SourceSelect value={secondarySource?.id} sources={sources.filter((source) => source.id !== primarySource?.id)} onChange={setSecondary} /></div>}
    <div className="viewer-scenes">
      <div className="viewer-scene"><Scene source={primarySource} />{compare && <span className="scene-label">A · {primarySource?.label}</span>}</div>
      {compare && <div className="viewer-scene"><Scene source={secondarySource} /><span className="scene-label">B · {secondarySource?.label}</span></div>}
    </div>
  </section>;
}
