import { useEffect, useMemo, useRef, useState } from "react";
import type { Display, Viewer } from "three-cad-viewer";
import { Box, FolderOpen, Share2 } from "./icons";
import type { MeshDocument, QuickGeometryCheck, QuickSectionCheck } from "@shared/contracts";
import { toThreeCadShapes } from "../lib/cad-scene";

export function CadViewer({ artifactPath, expectedSha, revision = 0, meshDocument, targetScope = "current", onReferencePart }: { artifactPath?: string; expectedSha?: string; revision?: number; meshDocument?: MeshDocument | null; targetScope?: string; onReferencePart?: (reference: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<CadDisplay | null>(null);
  const [mesh, setMesh] = useState<MeshDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewerError, setViewerError] = useState("");
  const [selectedPart, setSelectedPart] = useState("");
  const [hiddenParts, setHiddenParts] = useState<Set<string>>(() => new Set());
  const [isolatedPart, setIsolatedPart] = useState("");
  const [quickCheck, setQuickCheck] = useState<QuickGeometryCheck | QuickSectionCheck | null>(null);
  const [quickBusy, setQuickBusy] = useState("");
  const [quickError, setQuickError] = useState("");
  const viewerRequired = mesh !== null;
  const assembly = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; solids: number }>();
    for (const part of mesh?.parts || []) {
      const id = part.partId || part.id || part.name;
      const current = groups.get(id);
      groups.set(id, { id, name: part.name, solids: (current?.solids || 0) + 1 });
    }
    return [...groups.values()];
  }, [mesh]);
  const visibleMesh = useMemo(() => mesh ? { ...mesh, parts: mesh.parts.filter((part) => {
    const id = part.partId || part.id || part.name;
    return isolatedPart ? id === isolatedPart : !hiddenParts.has(id);
  }) } : null, [mesh, hiddenParts, isolatedPart]);

  useEffect(() => {
    if (!viewerRequired || !host.current || viewer.current) return;
    let active = true;
    let display: CadDisplay | null = null;
    void import("three-cad-viewer").then((module) => {
      if (!active || !host.current) return;
      display = new CadDisplay(host.current, module);
      viewer.current = display;
      if (visibleMesh) display.render(visibleMesh);
    }).catch((reason) => {
      if (!active || !host.current) return;
      host.current.replaceChildren();
      setViewerError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; viewer.current = null; display?.dispose(); };
  }, [viewerRequired]);
  useEffect(() => { if (visibleMesh && viewer.current) viewer.current.render(visibleMesh); }, [visibleMesh]);
  useEffect(() => {
    if (selectedPart && !assembly.some((part) => part.id === selectedPart)) setSelectedPart("");
    setHiddenParts((current) => new Set([...current].filter((id) => assembly.some((part) => part.id === id))));
    if (isolatedPart && !assembly.some((part) => part.id === isolatedPart)) setIsolatedPart("");
  }, [assembly, selectedPart, isolatedPart]);
  useEffect(() => {
    setQuickCheck(null);
    setQuickError("");
    if (meshDocument) {
      setError("");
      setLoading(false);
      setMesh(meshDocument);
      return;
    }
    if (!artifactPath) return;
    let active = true;
    setError(""); setLoading(true);
    window.piCad.viewer.loadStep(artifactPath)
      .then((document) => { if (!active) return; if (expectedSha && document.sha256 !== expectedSha) throw new Error(`Preserved artifact is missing: expected ${expectedSha.slice(0, 10)}, found ${(document.sha256 || "no hash").slice(0, 10)}. Rebuild this version before comparing it.`); setMesh(document); })
      .catch((reason) => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [artifactPath, expectedSha, revision, meshDocument]);

  const open = async () => {
    const path = await window.piCad.viewer.chooseStep();
    if (!path) return;
    setError(""); setLoading(true);
    try { setMesh(await window.piCad.viewer.loadStep(path)); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  };

  const exportOpenModel = async () => {
    const source = mesh?.source || artifactPath;
    if (!source) return;
    setError("");
    try { await window.piCad.viewer.exportStep(source); }
    catch (reason) { setError(String(reason)); }
  };

  const inspectDimension = async (axis: "x" | "y" | "z") => {
    const source = mesh?.source || artifactPath;
    if (!source) return;
    setQuickError(""); setQuickBusy(`Measure ${axis.toUpperCase()}`);
    try { setQuickCheck(await window.piCad.viewer.inspectGeometry(source)); }
    catch (reason) { setQuickError(String(reason)); }
    finally { setQuickBusy(""); }
  };

  const inspectSection = async (axis: "x" | "y" | "z") => {
    const source = mesh?.source || artifactPath;
    if (!source) return;
    setQuickError(""); setQuickBusy(`Section ${axis.toUpperCase()}`);
    try { setQuickCheck(await window.piCad.viewer.inspectSection(source, axis)); }
    catch (reason) { setQuickError(String(reason)); }
    finally { setQuickBusy(""); }
  };

  const quickSummary = quickCheck && ("bbox" in quickCheck
    ? `Bounding box · X ${quickCheck.bbox.x} ${quickCheck.units} · Y ${quickCheck.bbox.y} ${quickCheck.units} · Z ${quickCheck.bbox.z} ${quickCheck.units} · ${quickCheck.solidCount} solids`
    : `Section ${quickCheck.axis.toUpperCase()} at ${quickCheck.position} ${quickCheck.units} · area ${quickCheck.totalArea} ${quickCheck.units}² · ${quickCheck.faceCount} faces`);
  const referenceQuickCheck = (agent = false) => {
    if (!quickCheck || !quickSummary) return;
    const target = targetScope === "current" || targetScope === "head" ? "current model" : `historical ${targetScope} artifact`;
    onReferencePart?.(`${agent ? "Inspect and verify this read-only result in the current engineering task" : "Reference this measured result"}: ${quickSummary}. Target the ${target} at ${quickCheck.source} with SHA-256 ${quickCheck.sha256}. Do not modify the artifact; verify its hash is unchanged.`);
  };

  return <section className="cad-viewer" data-testid="cad-viewer">
    <div ref={host} className="viewer-canvas cad-viewer-open-source" />
    {mesh && assembly.length > 0 && <aside className="assembly-tree" aria-label="Assembly tree"><header><strong>Assembly</strong><button onClick={() => { setHiddenParts(new Set()); setIsolatedPart(""); }}>Show all</button></header>{assembly.map((part) => <div key={part.id} className={selectedPart === part.id ? "selected" : ""}><button className="assembly-part" onClick={() => setSelectedPart(part.id)}><strong>{part.name}</strong><small>{part.id} · {part.solids} solid{part.solids === 1 ? "" : "s"}</small></button><button aria-label={`${hiddenParts.has(part.id) ? "Show" : "Hide"} ${part.name} ${part.id}`} onClick={() => setHiddenParts((current) => { const next = new Set(current); if (next.has(part.id)) next.delete(part.id); else next.add(part.id); return next; })}>{hiddenParts.has(part.id) ? "Show" : "Hide"}</button><button aria-label={`Isolate ${part.name} ${part.id}`} onClick={() => setIsolatedPart((current) => current === part.id ? "" : part.id)}>{isolatedPart === part.id ? "Unisolate" : "Isolate"}</button></div>)}{selectedPart && <footer><span>Selected · {selectedPart} · version {mesh.sha256?.slice(0, 10) || "unknown"}</span><button onClick={() => { const part = assembly.find((item) => item.id === selectedPart)!; onReferencePart?.(`Modify assembly part ${part.name} [partId=${part.id}] from model version ${mesh.sha256 || "unknown"}. Preserve this stable part identity and do not change unrelated parts.`); }}>Ask Agent to modify</button></footer>}</aside>}
    {mesh && <aside className="quick-inspect" aria-label="Quick inspection">
      <header><strong>Inspect</strong><small>{targetScope === "current" || targetScope === "head" ? "Current model" : `Historical · ${targetScope}`}</small></header>
      <div><span>Measure</span>{(["x", "y", "z"] as const).map((axis) => <button key={`measure-${axis}`} disabled={Boolean(quickBusy)} onClick={() => void inspectDimension(axis)}>{axis.toUpperCase()}</button>)}</div>
      <div><span>Section</span>{(["x", "y", "z"] as const).map((axis) => <button key={`section-${axis}`} disabled={Boolean(quickBusy)} onClick={() => void inspectSection(axis)}>{axis.toUpperCase()}</button>)}</div>
      {quickBusy && <p aria-live="polite">{quickBusy}…</p>}
      {quickSummary && <output><strong>{quickSummary}</strong><small title={quickCheck!.source}>{quickCheck!.source} · SHA {quickCheck!.sha256.slice(0, 12)}</small><span><button onClick={() => referenceQuickCheck()}>Reference in conversation</button><button onClick={() => referenceQuickCheck(true)}>Ask Agent for read-only check</button></span></output>}
      {quickError && <p role="alert">Inspection failed · {quickError}</p>}
    </aside>}
    {mesh && <div className="viewer-file-actions">
      <span className="viewer-file-identity" title={mesh.source}>{mesh.source.split(/[\\/]/).at(-1)}{mesh.sha256 && <code>{mesh.sha256.slice(0, 10)}</code>}</span>
      <button onClick={() => void open()}><FolderOpen size={14} />Open STEP</button>
      <button onClick={() => void exportOpenModel()}><Share2 size={14} />Export copy</button>
    </div>}
    {mesh && error && <div className="viewer-load-error" role="alert"><strong>Could not open that STEP.</strong><span>The current model is preserved.</span><small>{error}</small></div>}
    {(!mesh || viewerError) && <div className="viewer-empty"><span className="viewer-empty-mark"><Box size={28} /></span><strong>{viewerError ? "3D preview unavailable" : loading ? "Preparing model…" : error ? "Model unavailable" : "No model open"}</strong><p>{viewerError || error || "Build a candidate or open a project STEP file."}</p>{!viewerError && <button onClick={() => void open()}><FolderOpen size={15} />Open STEP</button>}</div>}
  </section>;
}

class CadDisplay {
  private readonly display: Display;
  private readonly viewer: Viewer;
  private readonly resize: ResizeObserver;
  private rendered = false;

  constructor(private readonly host: HTMLElement, module: typeof import("three-cad-viewer")) {
    const width = Math.max(host.clientWidth, 320);
    const height = Math.max(host.clientHeight, 240);
    const display = new module.Display(host, {
      cadWidth: width, height, treeWidth: 260, treeHeight: Math.max(220, height - 80),
      theme: "light", glass: true, pinning: true, tools: true,
      measureTools: false, externalMeasurementBackend: false, selectTool: true,
      explodeTool: true, zscaleTool: false, zebraTool: false, studioTool: false,
    });
    this.display = display;
    try { this.viewer = new module.Viewer(display, { up: "Z", target: [0, 0, 0] }, () => undefined); }
    catch (error) { display.dispose(); throw error; }
    this.resize = new ResizeObserver(() => {
      if (!this.rendered) return;
      const nextWidth = Math.max(host.clientWidth, 320);
      const nextHeight = Math.max(host.clientHeight, 240);
      this.viewer.resizeCadView(nextWidth, 260, nextHeight, true);
    });
    this.resize.observe(host);
  }

  render(document: MeshDocument) {
    this.viewer.render(toThreeCadShapes(document), {
      ambientIntensity: 1.25, directIntensity: 2.1, metalness: 0.08,
      roughness: 0.58, edgeColor: 0x737b84, defaultOpacity: 1,
    }, { up: "Z", target: [
      (document.bounds.min[0] + document.bounds.max[0]) / 2,
      (document.bounds.min[1] + document.bounds.max[1]) / 2,
      (document.bounds.min[2] + document.bounds.max[2]) / 2,
    ] });
    this.rendered = true;
  }

  dispose() { this.resize.disconnect(); this.viewer.dispose(); this.display.dispose(); }
}
