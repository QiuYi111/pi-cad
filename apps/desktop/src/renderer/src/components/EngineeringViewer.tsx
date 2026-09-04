import { useCallback, useEffect, useMemo, useState } from "react";
import type { MeshDocument, ModelParameterValue, ViewerCatalog, ViewerSource } from "@shared/contracts";
import { Boxes, GitBranch, RefreshCw, Waves } from "./icons";
import { CadViewer } from "./CadViewer";
import { ParaViewFrame } from "./ParaViewFrame";
import { preferredSource, sourceForArtifact, sourcesFromCatalog } from "../lib/viewer-catalog";
import { ParameterPanel } from "./ParameterPanel";

const EMPTY: ViewerCatalog = { projectId: "", projectHead: { updatedAt: "", artifacts: [] }, currentRun: null, commits: [], simulationRuns: [], parameterManifests: [] };

function Scene({ source, revision, meshDocument }: { source?: ViewerSource; revision: number; meshDocument?: MeshDocument | null }) {
  if (!source) return <CadViewer />;
  return source.kind === "cad" ? <CadViewer artifactPath={source.path} revision={revision} meshDocument={meshDocument} /> : <ParaViewFrame source={source} />;
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
  const [previewMesh, setPreviewMesh] = useState<MeshDocument | null>(null);
  const [viewerEpoch, setViewerEpoch] = useState(0);
  const sources = useMemo(() => sourcesFromCatalog(catalog, latestArtifact), [catalog, latestArtifact]);
  const primarySource = sources.find((source) => source.id === selected) ?? preferredSource(sources);
  const secondarySource = sources.find((source) => source.id === secondary) ?? sources.find((source) => source.id !== primarySource?.id);
  const parameterManifest = primarySource?.kind === "cad" ? catalog.parameterManifests.find((stored) => {
    const sourcePath = primarySource.path.replaceAll("\\", "/");
    return stored.manifest.output.path.replaceAll("\\", "/") === sourcePath
      && (!primarySource.sha256 || stored.manifest.output.sha256 === primarySource.sha256);
  }) : undefined;

  const refresh = async () => {
    if (!projectPath) return;
    setLoading(true); setCatalogError("");
    try { setCatalog(await window.piCad.viewer.catalog()); }
    catch (error) { setCatalogError(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    setCatalog(EMPTY);
    setSelected("");
    setSecondary("");
    setCompare(false);
    setPreviewMesh(null);
    if (projectPath) void refresh();
  }, [projectPath]);
  useEffect(() => { if (projectPath && revision > 0) void refresh(); }, [revision]);
  useEffect(() => {
    const latest = sourceForArtifact(sources, latestArtifact);
    if (latest) {
      setSelected(latest.id);
      setCompare(false);
      return;
    }
  }, [sources, latestArtifact, revision]);
  useEffect(() => {
    if (!selected && sources.length) setSelected(preferredSource(sources)?.id ?? sources[0]!.id);
    if (selected && !sources.some((source) => source.id === selected)) setSelected(preferredSource(sources)?.id ?? sources[0]?.id ?? "");
  }, [sources, selected]);
  useEffect(() => { setPreviewMesh(null); }, [primarySource?.id]);
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

  const previewParameters = useCallback((values: Record<string, ModelParameterValue>) => {
    if (!parameterManifest) return Promise.reject(new Error("This model no longer has active parameters."));
    return window.piCad.viewer.previewParameters(parameterManifest.path, values);
  }, [parameterManifest?.path]);
  const applyParameters = useCallback(async (values: Record<string, ModelParameterValue>) => {
    if (!parameterManifest) throw new Error("This model no longer has active parameters.");
    await window.piCad.viewer.applyParameters(parameterManifest.path, values);
  }, [parameterManifest?.path]);
  const applied = useCallback(async () => {
    setViewerEpoch((value) => value + 1);
    await refresh();
  }, [projectPath]);

  return <section className={`engineering-viewer ${compare ? "comparing" : ""} ${parameterManifest ? "has-parameters" : ""}`}>
    <header className="viewer-context-bar">
      <SourceSelect value={primarySource?.id} sources={sources} onChange={setSelected} />
      <span className="viewer-source-meta">{primarySource?.kind === "simulation" ? `${primarySource.outputType}${primarySource.unit ? ` · ${primarySource.unit}` : ""}` : primarySource ? primarySource.scope : "No active model"}</span>
      {catalogError && <span className="viewer-catalog-error" title={catalogError}>Catalog unavailable</span>}
      <button className={compare ? "active" : ""} onClick={() => setCompare((value) => !value)} disabled={sources.length < 2}><GitBranch size={14} />Compare</button>
      <button aria-label="Refresh viewer catalog" onClick={() => void refresh()} className={loading ? "spinning" : ""}><RefreshCw size={14} /></button>
    </header>
    {compare && <div className="compare-secondary-bar"><span>Against</span><SourceSelect value={secondarySource?.id} sources={sources.filter((source) => source.id !== primarySource?.id)} onChange={setSecondary} /></div>}
    <div className="viewer-workspace">
      <div className="viewer-scenes">
        <div className="viewer-scene"><Scene source={primarySource} revision={revision + viewerEpoch} meshDocument={previewMesh} />{compare && <span className="scene-label">A · {primarySource?.label}</span>}</div>
        {compare && <div className="viewer-scene"><Scene source={secondarySource} revision={revision + viewerEpoch} /><span className="scene-label">B · {secondarySource?.label}</span></div>}
      </div>
      {parameterManifest && <ParameterPanel
        stored={parameterManifest}
        onPreview={previewParameters}
        onPreviewReady={setPreviewMesh}
        onApply={applyParameters}
        onApplied={applied}
      />}
    </div>
  </section>;
}
