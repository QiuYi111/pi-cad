import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Box, Focus, FolderOpen, Grid3X3, Maximize2, Rotate3D, ScanLine } from "./icons";
import type { MeshDocument } from "@shared/contracts";

export function CadViewer({ artifactPath }: { artifactPath?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);
  const [mesh, setMesh] = useState<MeshDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [orthographic, setOrthographic] = useState(false);
  const [grid, setGrid] = useState(true);
  const [explode, setExplode] = useState(0);
  const [section, setSection] = useState(false);
  const [sectionPosition, setSectionPosition] = useState(.5);

  useEffect(() => {
    if (!host.current) return;
    const viewer = new ViewerScene(host.current);
    sceneRef.current = viewer;
    return () => viewer.dispose();
  }, []);
  useEffect(() => { if (mesh) sceneRef.current?.setMesh(mesh); }, [mesh]);
  useEffect(() => { sceneRef.current?.setProjection(orthographic); }, [orthographic]);
  useEffect(() => { sceneRef.current?.setGrid(grid); }, [grid]);
  useEffect(() => { sceneRef.current?.setExplode(explode); }, [explode]);
  useEffect(() => { sceneRef.current?.setSection(section, sectionPosition); }, [section, sectionPosition]);
  useEffect(() => {
    if (!artifactPath) return;
    let active = true;
    setError("");
    setLoading(true);
    window.piCad.viewer.loadStep(artifactPath).then((document) => { if (active) setMesh(document); }).catch((reason) => { if (active) setError(String(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [artifactPath]);

  const open = async () => {
    const path = await window.piCad.viewer.chooseStep();
    if (!path) return;
    setError("");
    setLoading(true);
    try { setMesh(await window.piCad.viewer.loadStep(path)); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  };

  return <section className="cad-viewer" data-testid="cad-viewer">
    <div ref={host} className="viewer-canvas" />
    {!mesh && <div className="viewer-empty"><span className="viewer-empty-mark"><Box size={28} /></span><strong>{loading ? "Preparing model…" : error ? "Model unavailable" : "No model open"}</strong><p>{error || "Build a candidate or open a project STEP file."}</p><button onClick={() => void open()}><FolderOpen size={15} />Open STEP</button></div>}
    <div className="viewer-toolbar">
      <button onClick={() => sceneRef.current?.fit()} title="Fit"><Focus size={17} /></button>
      <button onClick={() => sceneRef.current?.reset()} title="Isometric"><Rotate3D size={17} /></button>
      <button className={orthographic ? "active" : ""} onClick={() => setOrthographic(!orthographic)} title="Projection"><Maximize2 size={17} /></button>
      <button className={grid ? "active" : ""} onClick={() => setGrid(!grid)} title="Grid"><Grid3X3 size={17} /></button>
      <button className={section ? "active" : ""} onClick={() => setSection(!section)} title="Section"><ScanLine size={17} /></button>
    </div>
    {mesh && <div className="viewer-sliders"><label><span>Explode</span><input type="range" min="0" max="1" step="0.01" value={explode} onChange={(event) => setExplode(Number(event.target.value))} /></label>{section && <label><span>Section</span><input type="range" min="0" max="1" step="0.01" value={sectionPosition} onChange={(event) => setSectionPosition(Number(event.target.value))} /></label>}</div>}
    <div className="view-cube" aria-label="View orientation"><button onClick={() => sceneRef.current?.view("top")}>TOP</button><button onClick={() => sceneRef.current?.view("front")}>FRONT</button><button onClick={() => sceneRef.current?.view("right")}>RIGHT</button></div>
    <div className="axis-gizmo"><i className="x" />X<i className="y" />Y<i className="z" />Z</div>
  </section>;
}

class ViewerScene {
  private scene = new THREE.Scene();
  private perspective = new THREE.PerspectiveCamera(35, 1, .1, 100000);
  private orthographic = new THREE.OrthographicCamera(-100, 100, 100, -100, .1, 100000);
  private camera: THREE.Camera = this.perspective;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private model = new THREE.Group();
  private grid = new THREE.GridHelper(1000, 40, 0x30343a, 0x1b1e22);
  private resize: ResizeObserver;
  private animation = 0;
  private centers: THREE.Vector3[] = [];
  private clipping = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private zBounds: [number, number] = [0, 1];

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x090a0b, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.host.appendChild(this.renderer.domElement);
    this.perspective.position.set(160, -190, 140);
    this.orthographic.position.copy(this.perspective.position);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .08;
    this.controls.screenSpacePanning = true;
    this.scene.add(this.model, this.grid);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(new THREE.HemisphereLight(0xf5f7fa, 0x181a1e, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 4.5); key.position.set(160, -100, 220); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6f91ff, 1.5); rim.position.set(-180, 120, 80); this.scene.add(rim);
    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(host);
    this.onResize();
    this.loop();
  }

  setMesh(document: MeshDocument) {
    this.model.clear(); this.centers = [];
    this.zBounds = [document.bounds.min[2], document.bounds.max[2]];
    const globalCenter = new THREE.Vector3(
      (document.bounds.min[0] + document.bounds.max[0]) / 2,
      (document.bounds.min[1] + document.bounds.max[1]) / 2,
      (document.bounds.min[2] + document.bounds.max[2]) / 2,
    );
    document.parts.forEach((part) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(part.positions, 3));
      geometry.setIndex(part.indices);
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const material = new THREE.MeshStandardMaterial({ color: part.color, metalness: .12, roughness: .48, side: THREE.DoubleSide, clippingPlanes: [this.clipping] });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = part.name;
      const center = new THREE.Vector3(); geometry.boundingBox?.getCenter(center); this.centers.push(center.sub(globalCenter));
      this.model.add(mesh);
    });
    this.fit(document.bounds);
  }

  setExplode(amount: number) { this.model.children.forEach((part, index) => part.position.copy(this.centers[index] || new THREE.Vector3()).multiplyScalar(amount * 1.2)); }
  setSection(enabled: boolean, position: number) { this.renderer.localClippingEnabled = enabled; this.clipping.constant = this.zBounds[0] + (this.zBounds[1] - this.zBounds[0]) * position; }
  setGrid(visible: boolean) { this.grid.visible = visible; }
  setProjection(orthographic: boolean) { this.camera = orthographic ? this.orthographic : this.perspective; this.controls.object = this.camera; this.controls.update(); this.onResize(); }
  fit(bounds?: MeshDocument["bounds"]) {
    const box = bounds ? new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max)) : new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    const sphere = new THREE.Sphere(); box.getBoundingSphere(sphere);
    const radius = Math.max(sphere.radius, 1);
    this.controls.target.copy(sphere.center);
    const direction = new THREE.Vector3(1, -1.2, .9).normalize();
    this.perspective.position.copy(sphere.center).add(direction.multiplyScalar(radius * 3.2));
    this.perspective.near = radius / 100; this.perspective.far = radius * 100; this.perspective.updateProjectionMatrix();
    this.orthographic.position.copy(this.perspective.position); this.updateOrtho(radius * 1.6);
    this.controls.update();
  }
  reset() { this.fit(); }
  view(side: "top" | "front" | "right") {
    const distance = this.camera.position.distanceTo(this.controls.target) || 100;
    const direction = side === "top" ? new THREE.Vector3(0, 0, 1) : side === "front" ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(1, 0, 0);
    this.camera.position.copy(this.controls.target).add(direction.multiplyScalar(distance));
    this.camera.up.set(0, 0, side === "top" ? 1 : 1); if (side === "top") this.camera.up.set(0, 1, 0);
    this.controls.update();
  }
  private updateOrtho(size: number) { const aspect = this.host.clientWidth / Math.max(this.host.clientHeight, 1); this.orthographic.left = -size * aspect; this.orthographic.right = size * aspect; this.orthographic.top = size; this.orthographic.bottom = -size; this.orthographic.updateProjectionMatrix(); }
  private onResize() { const width = this.host.clientWidth, height = this.host.clientHeight; this.renderer.setSize(width, height, false); this.perspective.aspect = width / Math.max(height, 1); this.perspective.updateProjectionMatrix(); this.updateOrtho(Math.max(30, this.camera.position.distanceTo(this.controls.target) / 2.2)); }
  private loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); this.animation = requestAnimationFrame(this.loop); };
  dispose() { cancelAnimationFrame(this.animation); this.resize.disconnect(); this.controls.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); }
}
