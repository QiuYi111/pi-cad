import { useEffect, useRef, useState } from "react";
import type { Display, Viewer } from "three-cad-viewer";
import { Box, FolderOpen } from "./icons";
import type { MeshDocument } from "@shared/contracts";
import { toThreeCadShapes } from "../lib/cad-scene";

export function CadViewer({ artifactPath }: { artifactPath?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<CadDisplay | null>(null);
  const [mesh, setMesh] = useState<MeshDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewerError, setViewerError] = useState("");
  const viewerRequired = mesh !== null;

  useEffect(() => {
    if (!viewerRequired || !host.current || viewer.current) return;
    let active = true;
    let display: CadDisplay | null = null;
    void import("three-cad-viewer").then((module) => {
      if (!active || !host.current) return;
      display = new CadDisplay(host.current, module);
      viewer.current = display;
      if (mesh) display.render(mesh);
    }).catch((reason) => {
      if (!active || !host.current) return;
      host.current.replaceChildren();
      setViewerError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; viewer.current = null; display?.dispose(); };
  }, [viewerRequired]);
  useEffect(() => { if (mesh && viewer.current) viewer.current.render(mesh); }, [mesh]);
  useEffect(() => {
    if (!artifactPath) return;
    let active = true;
    setError(""); setLoading(true);
    window.piCad.viewer.loadStep(artifactPath)
      .then((document) => { if (active) setMesh(document); })
      .catch((reason) => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [artifactPath]);

  const open = async () => {
    const path = await window.piCad.viewer.chooseStep();
    if (!path) return;
    setError(""); setLoading(true);
    try { setMesh(await window.piCad.viewer.loadStep(path)); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  };

  return <section className="cad-viewer" data-testid="cad-viewer">
    <div ref={host} className="viewer-canvas cad-viewer-open-source" />
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
      theme: "dark", glass: true, pinning: true, tools: true,
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
