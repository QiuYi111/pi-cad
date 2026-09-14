import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlenderRender, HumanApproval, MediaAttachment, MeshDocument, ModelParameterValue, ReleaseResult, SourceRebuildResult, ViewerCatalog, ViewerSource } from "@shared/contracts";
import { Boxes, GitBranch, RefreshCw, Waves } from "./icons";
import { CadViewer } from "./CadViewer";
import { ParaViewFrame } from "./ParaViewFrame";
import { preferredSource, sourceForArtifact, sourcesFromCatalog } from "../lib/viewer-catalog";
import { ParameterPanel } from "./ParameterPanel";
import { SimulationLauncher } from "./SimulationLauncher";
import { BlenderFrame } from "./BlenderFrame";

const EMPTY: ViewerCatalog = { projectId: "", projectHead: { updatedAt: "", artifacts: [] }, currentRun: null, commits: [], simulationRuns: [], parameterManifests: [] };

function sameProjectPath(left: string, right: string): boolean {
  const a = left.replaceAll("\\", "/").replace(/^\.\//, "");
  const b = right.replaceAll("\\", "/").replace(/^\.\//, "");
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function Scene({ source, revision, meshDocument, currentModel, onReferencePart, onBlenderRender }: { source?: ViewerSource; revision: number; meshDocument?: MeshDocument | null; currentModel?: Extract<ViewerSource, { kind: "cad" }>; onReferencePart?: (reference: string) => void; onBlenderRender?: (render: BlenderRender) => void }) {
  if (!source) return <CadViewer />;
  if (source.kind === "cad") return <CadViewer artifactPath={source.path} expectedSha={source.sha256} revision={revision} meshDocument={meshDocument} targetScope={source.scope} onReferencePart={onReferencePart} />;
  if (source.kind === "blender") return <BlenderFrame source={source} onRendered={onBlenderRender} />;
  return <ParaViewFrame source={source} currentModel={currentModel} onRerun={onReferencePart} />;
}

function SourceSelect({ value, sources, onChange }: { value?: string; sources: ViewerSource[]; onChange: (value: string) => void }) {
  const cad = sources.filter((source) => source.kind === "cad");
  const simulations = sources.filter((source) => source.kind === "simulation");
  const scenes = sources.filter((source) => source.kind === "blender");
  return <label className="viewer-source-select">
    {sources.find((source) => source.id === value)?.kind === "simulation" ? <Waves size={14} /> : <Boxes size={14} />}
    <select value={value || ""} onChange={(event) => onChange(event.target.value)} aria-label="Viewer source">
      {!sources.length && <option value="">No results</option>}
      {!!cad.length && <optgroup label="Models">{cad.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</optgroup>}
      {!!simulations.length && <optgroup label="Simulation">{simulations.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</optgroup>}
      {!!scenes.length && <optgroup label="Blender scenes">{scenes.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</optgroup>}
    </select>
  </label>;
}

export function EngineeringViewer({ projectPath, latestArtifact, revision, openedMesh, mediaArtifacts = [], agentRunning = false, onAskAgent, onStopAgent }: { projectPath: string; latestArtifact?: string; revision: number; openedMesh?: MeshDocument | null; mediaArtifacts?: MediaAttachment[]; agentRunning?: boolean; onAskAgent?: (request: string) => void; onStopAgent?: () => void }) {
  const [catalog, setCatalog] = useState<ViewerCatalog>(EMPTY);
  const [selected, setSelected] = useState("");
  const [compare, setCompare] = useState(false);
  const [secondary, setSecondary] = useState("");
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [previewMesh, setPreviewMesh] = useState<MeshDocument | null>(null);
  const [viewerEpoch, setViewerEpoch] = useState(0);
  const [artifactFilter, setArtifactFilter] = useState<"all" | "model" | "result">("all");
  const [mediaPreview, setMediaPreview] = useState<MediaAttachment | null>(null);
  const [renderArtifacts, setRenderArtifacts] = useState<MediaAttachment[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildResult, setRebuildResult] = useState<SourceRebuildResult | null>(null);
  const [rebuildError, setRebuildError] = useState("");
  const [evidencePreview, setEvidencePreview] = useState<{ path: string; value?: unknown; error?: string } | null>(null);
  const [approvals, setApprovals] = useState<HumanApproval[]>([]);
  const [approvalScope, setApprovalScope] = useState("release package");
  const [approvalRationale, setApprovalRationale] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [releaseMessage, setReleaseMessage] = useState("");
  const [release, setRelease] = useState<ReleaseResult | null>(null);
  const [remoteName, setRemoteName] = useState("origin");
  const [releaseTag, setReleaseTag] = useState("");
  const selectionPinned = useRef(false);
  const sources = useMemo(() => sourcesFromCatalog(catalog, latestArtifact), [catalog, latestArtifact]);
  const primarySource = sources.find((source) => source.id === selected) ?? preferredSource(sources);
  const currentModel = preferredSource(sources.filter((source) => source.kind === "cad")) as Extract<ViewerSource, { kind: "cad" }> | undefined;
  const allMedia = [...renderArtifacts, ...mediaArtifacts];
  const selectableSources = sources.filter((source) => source.kind === "simulation" || source.scope !== "commit" || showHistory || source.id === primarySource?.id);
  const rendered = (value: BlenderRender) => setRenderArtifacts((items) => [{ id: value.path, mimeType: "image/png", role: "blender-render", label: `${value.camera} render`, path: value.path, dataUrl: value.dataUrl }, ...items.filter((item) => item.id !== value.path)]);
  const [preservedCad, setPreservedCad] = useState<Extract<ViewerSource, { kind: "cad" }> | undefined>();
  const [preservedSimulation, setPreservedSimulation] = useState<Extract<ViewerSource, { kind: "simulation" }> | undefined>();
  const [preservedBlender, setPreservedBlender] = useState<Extract<ViewerSource, { kind: "blender" }> | undefined>();
  const secondarySource = sources.find((source) => source.id === secondary) ?? sources.find((source) => source.id !== primarySource?.id);
  const visibleSources = sources.filter((source) => (source.kind === "simulation" || source.scope !== "commit" || showHistory) && (artifactFilter === "all" || (artifactFilter === "model" ? source.kind === "cad" : source.kind !== "cad")));
  const chooseSource = (id: string) => { selectionPinned.current = true; setSelected(id); };
  const parameterManifest = primarySource?.kind === "cad" ? catalog.parameterManifests.find((stored) => {
    return sameProjectPath(stored.manifest.output.path, primarySource.path)
      && (!primarySource.sha256 || stored.manifest.output.sha256 === primarySource.sha256);
  }) : undefined;
  const secondaryParameterManifest = secondarySource?.kind === "cad" ? catalog.parameterManifests.find((stored) => sameProjectPath(stored.manifest.output.path, secondarySource.path) && (!secondarySource.sha256 || stored.manifest.output.sha256 === secondarySource.sha256)) : undefined;
  const parameterDelta = parameterManifest && secondaryParameterManifest
    ? parameterManifest.manifest.parameters.flatMap((parameter) => {
      const other = secondaryParameterManifest.manifest.parameters.find((candidate) => candidate.id === parameter.id);
      return other && other.value !== parameter.value ? [`${parameter.label || parameter.id}: ${String(parameter.value)} ↔ ${String(other.value)}${parameter.unit ? ` ${parameter.unit}` : ""}`] : [];
    })
    : [];
  const selectedCommit = primarySource && "commitId" in primarySource ? catalog.commits.find((commit) => commit.id === primarySource.commitId) : undefined;

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
    selectionPinned.current = false;
    if (projectPath) void refresh();
  }, [projectPath]);
  useEffect(() => { if (projectPath && revision > 0) void refresh(); }, [revision]);
  useEffect(() => { if (projectPath) void window.piCad.approvals.list().then(setApprovals).catch(() => setApprovals([])); }, [projectPath, revision, catalog.commits.length]);
  useEffect(() => {
    const latest = sourceForArtifact(sources, latestArtifact);
    if (latest && !selectionPinned.current) {
      setSelected(latest.id);
      setCompare(false);
      return;
    }
  }, [sources, latestArtifact, revision]);
  useEffect(() => {
    if (!openedMesh?.source) return;
    const opened = sourceForArtifact(sources, openedMesh.source);
    if (opened) { selectionPinned.current = true; setSelected(opened.id); setCompare(false); }
  }, [openedMesh?.source, sources]);
  useEffect(() => {
    if (!selected && sources.length) setSelected(preferredSource(sources)?.id ?? sources[0]!.id);
    if (selected && !sources.some((source) => source.id === selected)) setSelected(preferredSource(sources)?.id ?? sources[0]?.id ?? "");
  }, [sources, selected]);
  useEffect(() => { setPreviewMesh(null); }, [primarySource?.id]);
  useEffect(() => {
    if (primarySource?.kind === "cad") setPreservedCad(primarySource);
    if (primarySource?.kind === "simulation") setPreservedSimulation(primarySource);
    if (primarySource?.kind === "blender") setPreservedBlender(primarySource);
  }, [primarySource?.id]);
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

  return <section className={`engineering-viewer ${compare ? "comparing" : ""} ${parameterManifest ? "has-parameters" : ""} ${primarySource?.kind === "cad" ? "has-inspector" : ""}`}>
    <header className="viewer-context-bar">
      <SourceSelect value={primarySource?.id} sources={selectableSources} onChange={chooseSource} />
      <span className="viewer-source-meta">{primarySource?.kind === "simulation" ? `${primarySource.outputType}${primarySource.unit ? ` · ${primarySource.unit}` : ""}` : primarySource ? primarySource.scope : "No active model"}</span>
      {catalogError && <span className="viewer-catalog-error" title={catalogError}>Catalog unavailable</span>}
      <button className={compare ? "active" : ""} onClick={() => setCompare((value) => !value)} disabled={sources.length < 2}><GitBranch size={14} />Compare</button>
      {currentModel && <button onClick={() => onAskAgent?.(`Submit the current candidate ${currentModel.path}${currentModel.sha256 ? ` with SHA-256 ${currentModel.sha256}` : ""} for the independent machine review required by the pinned workflow. Reuse an existing review for the exact same candidate and acceptance contract; do not treat machine review as human approval.`)}>Submit review</button>}
      <button aria-label="Refresh viewer catalog" onClick={() => void refresh()} className={loading ? "spinning" : ""}><RefreshCw size={14} /></button>
    </header>
    {compare && <div className="compare-secondary-bar"><span>Against</span><SourceSelect value={secondarySource?.id} sources={selectableSources.filter((source) => source.id !== primarySource?.id)} onChange={setSecondary} /><button onClick={() => setViewerEpoch((value) => value + 1)}>Sync view</button><small>A {primarySource?.sha256?.slice(0, 10) || "no hash"} · B {secondarySource?.sha256?.slice(0, 10) || "no hash"} · {parameterDelta.length ? `Known parameters · ${parameterDelta.join("; ")}` : "No preserved parameter delta; visual differences are inferred."}</small></div>}
    <div className="viewer-workspace">
      {selectedCommit?.acceptanceSummary && <aside className="acceptance-summary"><header><strong>Acceptance · {selectedCommit.name}</strong><small>{selectedCommit.sourceRevision?.slice(0, 12) || "source revision unavailable"}</small></header>{(["geometry", "engineering", "machine"] as const).map((category) => <section key={category}><h3>{category === "geometry" ? "Geometry validity" : category === "engineering" ? "Engineering checks" : "Machine judgment"}</h3>{selectedCommit.acceptanceSummary!.requirements.filter((item) => item.category === category).map((item) => <div key={item.id} className={item.status}><span>{item.status}</span><strong>{item.id}</strong><small>{item.method}</small>{item.evidence && <button onClick={async () => { setEvidencePreview({ path: item.evidence!.path }); try { setEvidencePreview({ path: item.evidence!.path, value: await window.piCad.viewer.readEvidence(item.evidence!.path) }); } catch (error) { setEvidencePreview({ path: item.evidence!.path, error: String(error) }); } }}>Open evidence</button>}</div>)}{!selectedCommit.acceptanceSummary!.requirements.some((item) => item.category === category) && <p>Not verified for this version.</p>}</section>)}</aside>}
      {evidencePreview && <div className="evidence-preview" role="dialog" aria-label="Version evidence"><header><strong>{evidencePreview.path}</strong><button onClick={() => setEvidencePreview(null)}>Close</button></header><pre>{evidencePreview.error || (evidencePreview.value === undefined ? "Loading evidence…" : JSON.stringify(evidencePreview.value, null, 2))}</pre></div>}
      {selectedCommit && <aside className="human-approval"><header><strong>Human approval</strong><small>Bound to {selectedCommit.id}</small></header>{approvals.filter((item) => item.commitId === selectedCommit.id).map((item) => <div key={item.id} className={item.valid ? "valid" : "revoked"}><strong>{item.valid ? "Approved" : "Revoked"} · {item.scope}</strong><small>{item.approver.id} · {item.decidedAt}</small><p>{item.rationale}</p>{item.valid && <span><button onClick={async () => { setApprovalError(""); try { const result = await window.piCad.approvals.release(selectedCommit.id, item.id); if (result) { setRelease(result); setReleaseTag(`reify/${selectedCommit.id}`); setReleaseMessage(`${result.reused ? "Existing release verified" : "Released"} · ${result.path}`); } } catch (error) { setApprovalError(String(error)); } }}>Publish formal package</button><button onClick={async () => { const reason = window.prompt("Reason for revocation"); if (!reason) return; try { await window.piCad.approvals.revoke(item.id, reason); setApprovals(await window.piCad.approvals.list()); } catch (error) { setApprovalError(String(error)); } }}>Revoke</button></span>}</div>)}<label>Scope<input value={approvalScope} onChange={(event) => setApprovalScope(event.target.value)} /></label><label>Rationale<textarea value={approvalRationale} onChange={(event) => setApprovalRationale(event.target.value)} /></label><button disabled={!approvalRationale.trim()} onClick={async () => { setApprovalError(""); try { await window.piCad.approvals.approve(selectedCommit.id, approvalScope, approvalRationale); setApprovals(await window.piCad.approvals.list()); setApprovalRationale(""); } catch (error) { setApprovalError(String(error)); } }}>Approve this exact version</button>{release && <div className="remote-publish"><strong>Optional Git tag publication</strong><small>Commit {selectedCommit.sourceRevision?.slice(0, 12)} · the formal package stays local</small><label>Remote<input value={remoteName} onChange={(event) => setRemoteName(event.target.value)} /></label><label>Tag<input value={releaseTag} onChange={(event) => setReleaseTag(event.target.value)} /></label><button disabled={!remoteName.trim() || !releaseTag.trim()} onClick={async () => { setApprovalError(""); try { const result = await window.piCad.approvals.publishRemote(release, remoteName, releaseTag); setReleaseMessage(`${result.reused ? "Remote tag already verified" : "Remote tag published"} · ${result.remoteUrl} · ${result.tag} · package upload: no`); } catch (error) { setApprovalError(String(error)); } }}>Publish tag</button></div>}{releaseMessage && <p>{releaseMessage}</p>}{approvalError && <p role="alert">{approvalError}</p>}<small>Machine review and experience rating remain separate records.</small></aside>}
      <aside className="artifact-browser" aria-label="Artifacts">
        <header><strong>Artifacts</strong><small>{sources.length + allMedia.length}</small><button onClick={() => setShowHistory((value) => !value)}>{showHistory ? "Hide history" : "History"}</button></header>
        <nav aria-label="Artifact filters">{(["all", "model", "result"] as const).map((filter) => <button key={filter} className={artifactFilter === filter ? "active" : ""} onClick={() => setArtifactFilter(filter)}>{filter === "all" ? "All" : filter === "model" ? "Models" : "Results"}</button>)}</nav>
        <div>{visibleSources.map((source) => <button key={source.id} className={source.id === primarySource?.id ? "selected" : ""} onClick={() => chooseSource(source.id)}><strong>{source.label}</strong><span>{source.kind === "simulation" ? `${source.outputType} · run ${source.runId}` : `${source.scope} · ${source.role}`}</span><small>{source.sha256?.slice(0, 10) || source.path.split(/[\\/]/).at(-1)}</small></button>)}{artifactFilter !== "model" && allMedia.map((media) => <button key={media.id} onClick={() => setMediaPreview(media)}><strong>{media.label || media.role}</strong><span>image · tool output</span><small>{media.id}</small></button>)}</div>
        {!visibleSources.length && (artifactFilter === "model" || !allMedia.length) && <p>No artifacts in this filter.</p>}
      </aside>
      {mediaPreview && <div className="artifact-preview" role="dialog" aria-label="Artifact preview"><header><strong>{mediaPreview.label || mediaPreview.role}</strong><button onClick={() => setMediaPreview(null)}>Back to model</button></header>{mediaPreview.dataUrl ? <img src={mediaPreview.dataUrl} alt={mediaPreview.label || mediaPreview.role} /> : <p>Preview unavailable · {mediaPreview.path}</p>}<footer><span>{mediaPreview.role} · {mediaPreview.id}</span><button onClick={() => onAskAgent?.(`Reference visual artifact ${mediaPreview.id} (${mediaPreview.label || mediaPreview.role})${mediaPreview.path ? ` at ${mediaPreview.path}` : ""}. Keep its exact tool-output identity and model version in context.`)}>Reference in conversation</button></footer></div>}
      <div className="viewer-scenes">
        <div className="viewer-scene"><div className={`preserved-view ${primarySource?.kind === "cad" ? "active" : ""}`}><Scene source={primarySource?.kind === "cad" ? primarySource : preservedCad} revision={revision + viewerEpoch} meshDocument={previewMesh ?? (primarySource?.path === openedMesh?.source || primarySource?.path === latestArtifact ? openedMesh : null)} currentModel={currentModel} onReferencePart={onAskAgent} /></div><div className={`preserved-view ${primarySource?.kind === "simulation" ? "active" : ""}`}>{(primarySource?.kind === "simulation" || preservedSimulation) && <Scene source={primarySource?.kind === "simulation" ? primarySource : preservedSimulation} revision={revision + viewerEpoch} currentModel={currentModel} onReferencePart={onAskAgent} />}</div><div className={`preserved-view ${primarySource?.kind === "blender" ? "active" : ""}`}>{(primarySource?.kind === "blender" || preservedBlender) && <Scene source={primarySource?.kind === "blender" ? primarySource : preservedBlender} revision={revision + viewerEpoch} onBlenderRender={rendered} />}</div>{compare && <span className="scene-label">A · {primarySource?.label}</span>}</div>
        {compare && <div className="viewer-scene"><Scene source={secondarySource} revision={revision + viewerEpoch} /><span className="scene-label">B · {secondarySource?.label}</span></div>}
      </div>
      {parameterManifest && <ParameterPanel
        stored={parameterManifest}
        onPreview={previewParameters}
        onPreviewReady={setPreviewMesh}
        onApply={applyParameters}
        onApplied={applied}
        onAgentFix={onAskAgent}
      />}
      {primarySource?.kind === "cad" && primarySource.scope === "commit" && <aside className="source-rebuild"><strong>Rebuild preserved source</strong><small>Git · {primarySource.commitId} · artifact {primarySource.sha256?.slice(0, 10)}</small>{parameterManifest ? <button disabled={rebuilding} onClick={async () => { setRebuilding(true); setRebuildError(""); try { const result = await window.piCad.viewer.rebuildCommit(primarySource.commitId!, parameterManifest.path); setRebuildResult(result); } catch (error) { setRebuildError(String(error)); } finally { setRebuilding(false); } }}>{rebuilding ? "Rebuilding in isolated worktree…" : "Rebuild as new candidate"}</button> : <p>Missing preserved source parameters. This version cannot be reconstructed safely.</p>}{rebuildResult && <output><strong>{rebuildResult.byteMatch ? "Byte-identical reproduction" : rebuildResult.geometryMatch ? "Geometry matches; bytes differ" : "Reproduction differs or is unverified"}</strong><span>{rebuildResult.geometryDetail}</span><small>{rebuildResult.sourceRevision.slice(0, 12)} · {rebuildResult.environment.python} · output {rebuildResult.output}</small></output>}{rebuildError && <p role="alert">Rebuild failed · {rebuildError}</p>}</aside>}
      {!parameterManifest && primarySource?.kind === "cad" && <aside className="parameter-panel parameter-unbound" data-testid="parameter-unbound"><header><div><span>Selected model</span><strong>No bound parameters</strong><small>{primarySource.path}</small></div></header><p>This artifact does not expose editable source parameters.</p><button type="button" onClick={() => onAskAgent?.(`Modify the selected CAD model at ${primarySource.path}. Ask me which feature and target dimension should change, then preserve the model provenance.`)}>Ask Agent to modify</button></aside>}
      {primarySource?.kind === "cad" && <SimulationLauncher source={primarySource} running={agentRunning} onRun={onAskAgent} onStop={onStopAgent} />}
    </div>
  </section>;
}
