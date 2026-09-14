import { useEffect, useState } from "react";
import type { SimulationComponentStatus, ViewerSource } from "@shared/contracts";
import { Play, TriangleAlert, Waves } from "./icons";

export function SimulationLauncher({ source, running, onRun, onStop }: { source: Extract<ViewerSource, { kind: "cad" }>; running: boolean; onRun?: (request: string) => void; onStop?: () => void }) {
  const [open, setOpen] = useState(false);
  const [component, setComponent] = useState<SimulationComponentStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [youngs, setYoungs] = useState(70000);
  const [poisson, setPoisson] = useState(.33);
  const [force, setForce] = useState(-100);
  const [meshSize, setMeshSize] = useState(2);
  const inputError = youngs <= 0 ? "Young’s modulus must be positive." : poisson <= -1 || poisson >= .5 ? "Poisson ratio must be between -1 and 0.5." : force === 0 ? "Force must be non-zero." : meshSize <= 0 ? "Mesh size must be positive." : "";
  useEffect(() => { if (open) void window.piCad.runtime.checkSimulationComponent().then(setComponent); }, [open]);
  useEffect(() => {
    if (!installing) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [installing]);
  const install = async () => {
    setInstalling(true); setInstallError(""); setElapsed(0);
    try { setComponent(await window.piCad.runtime.installSimulationComponent()); }
    catch (error) { setInstallError(error instanceof Error ? error.message : String(error)); }
    finally { setInstalling(false); }
  };
  const run = () => onRun?.(`Run the managed simulation/torch-fem-linear-elastic Recipe for CAD artifact ${source.path} at SHA-256 ${source.sha256 || "unknown"}. The user confirmed: linear elastic material E=${youngs} MPa, nu=${poisson}; tetrahedral mesh size=${meshSize} mm; fix all DOFs on the x-min face; apply total force [0,0,${force}] N on the x-max face. Copy the repository Recipe into simulation/torch-fem-linear-elastic, bind the exact CAD/material/constraints/load/mesh/runtime inputs, run preflight and the managed CUDA solver, and record convergence, reaction balance, mesh refinement, displacement/stress fields, scalar extrema, visualization and runtime health. Do not accept the result from exit code alone.`);
  return <aside className="simulation-launcher" aria-label="Structural analysis">
    <button className="simulation-launcher-toggle" onClick={() => setOpen((value) => !value)}><Waves size={14} />Structural analysis</button>
    {open && <div><header><strong>Linear elastic · torch-fem 0.9</strong><small>{source.path} · {source.sha256?.slice(0, 10) || "unversioned"}</small></header>
      {component?.state !== "ready" ? <section className="simulation-component"><span><TriangleAlert size={14} />Optional solver component</span><p>Installs the pinned CUDA and CPU runtimes. Download and installed size: {component?.estimatedSize || "about 6 GB"}. Base CAD remains available.</p><button disabled={installing} onClick={() => void install()}>{installing ? `Installing · ${elapsed}s` : installError ? "Retry installation" : "Install component"}</button>{installError && <small role="alert">{installError}</small>}</section> : <>
        <div className="analysis-fields"><label>Young’s modulus<input aria-label="Young's modulus" type="number" value={youngs} onChange={(event) => setYoungs(Number(event.target.value))} /><span>MPa</span></label><label>Poisson ratio<input aria-label="Poisson ratio" type="number" step="0.01" value={poisson} onChange={(event) => setPoisson(Number(event.target.value))} /></label><label>Z force<input aria-label="Z force" type="number" value={force} onChange={(event) => setForce(Number(event.target.value))} /><span>N</span></label><label>Mesh size<input aria-label="Mesh size" type="number" value={meshSize} onChange={(event) => setMeshSize(Number(event.target.value))} /><span>mm</span></label></div>
        <p>Boundary · x-min fixed in X/Y/Z<br />Load · x-max total force<br />Runtime · managed CUDA; no CPU fallback</p>
        {inputError && <small role="alert">{inputError}</small>}
        {running ? <button onClick={onStop}>Stop analysis</button> : <button className="primary" disabled={Boolean(inputError)} onClick={run}><Play size={13} />Confirm and run</button>}
      </>}
    </div>}
  </aside>;
}
