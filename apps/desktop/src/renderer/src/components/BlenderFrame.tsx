import { useEffect, useState } from "react";
import type { BlenderRender, BlenderScene, ViewerSource } from "@shared/contracts";

export function BlenderFrame({ source, onRendered }: { source: Extract<ViewerSource, { kind: "blender" }>; onRendered?: (render: BlenderRender) => void }) {
  const [scene, setScene] = useState<BlenderScene | null>(null);
  const [camera, setCamera] = useState("");
  const [render, setRender] = useState<BlenderRender | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [editing, setEditing] = useState(false);
  const inspect = () => window.piCad.viewer.inspectBlender(source.path).then((value) => { setScene(value); setCamera(value.activeCamera || value.cameras[0] || ""); setError(""); }).catch((reason) => setError(String(reason)));
  useEffect(() => {
    let active = true; setError("");
    void window.piCad.viewer.inspectBlender(source.path).then((value) => { if (active) { setScene(value); setCamera(value.activeCamera || value.cameras[0] || ""); } }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [source.path]);
  const install = async () => { setInstalling(true); setError(""); try { await window.piCad.viewer.installBlender(); await inspect(); } catch (reason) { setError(String(reason)); } finally { setInstalling(false); } };
  const refreshAfterEdit = async () => { setBusy(true); try { await inspect(); setRender(null); setEditing(false); } finally { setBusy(false); } };
  const run = async () => {
    setBusy(true); setError("");
    try { const next = await window.piCad.viewer.renderBlender(source.path, camera); setRender(next); onRendered?.(next); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <section className="blender-frame">
    {render?.dataUrl ? <img src={render.dataUrl} alt={`${source.label} rendered with ${render.camera}`} /> : <div className="blender-scene-placeholder"><strong>{scene?.scene || source.label}</strong><span>{scene ? `${scene.objectCount} objects · frame ${scene.frame}/${scene.frameEnd}` : error ? "Blender scene unavailable" : "Opening real Blender scene…"}</span>{error && <button disabled={installing} onClick={() => void install()}>{installing ? "Preparing Blender…" : "Prepare optional Blender component"}</button>}</div>}
    <aside><strong>Blender scene</strong><small>{source.path} · {(scene?.sha256 || source.sha256)?.slice(0, 10) || "hash unavailable"}</small><label>Camera<select aria-label="Blender camera" value={camera} onChange={(event) => setCamera(event.target.value)}>{scene?.cameras.map((name) => <option key={name}>{name}</option>)}</select></label><span><button disabled={busy || !scene || !camera} onClick={() => void run()}>{busy ? "Rendering…" : "Render"}</button>{busy && <button onClick={() => void window.piCad.viewer.stopBlender()}>Stop</button>}</span><button disabled={!scene} onClick={async () => { await window.piCad.viewer.openBlenderDesktop(source.path); setEditing(true); }}>Open full Blender</button>{editing && <div className="blender-return"><small>Save in Blender, then return here. Blender handles unsaved changes when closing.</small><button disabled={busy} onClick={() => void refreshAfterEdit()}>I’m back · refresh saved scene</button></div>}{render && <small>Render · {render.camera} · {render.path}</small>}{error && <small className="error">{error}</small>}</aside>
  </section>;
}
