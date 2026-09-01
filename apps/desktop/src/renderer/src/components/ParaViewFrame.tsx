import { useEffect, useState } from "react";
import type { ParaViewSession, ViewerSource } from "@shared/contracts";
import { Maximize2, TriangleAlert, Waves } from "./icons";

export function ParaViewFrame({ source }: { source: Extract<ViewerSource, { kind: "simulation" }> }) {
  const [session, setSession] = useState<ParaViewSession>({ state: "starting", sourcePath: source.path });
  useEffect(() => {
    let active = true;
    setSession({ state: "starting", sourcePath: source.path });
    void window.piCad.viewer.openParaView(source.path).then((value) => { if (active) setSession(value); });
    return () => { active = false; };
  }, [source.path]);
  if (session.state === "ready" && session.url?.startsWith("http")) {
    return <section className="paraview-frame">
      <iframe src={session.url} title={`ParaView · ${source.label}`} allow="cross-origin-isolated" />
      <button className="paraview-desktop" onClick={() => void window.piCad.viewer.openParaViewDesktop(source.path)}><Maximize2 size={14} />Full ParaView</button>
    </section>;
  }
  if (session.state === "ready") return <section className="paraview-demo"><Waves size={38} /><strong>{source.label}</strong><span>ParaView session ready</span></section>;
  if (session.state === "error") return <section className="viewer-empty"><span className="viewer-empty-mark"><TriangleAlert size={26} /></span><strong>Simulation view unavailable</strong><p>{session.message}</p><button onClick={() => void window.piCad.viewer.openParaViewDesktop(source.path)}><Maximize2 size={14} />Open full ParaView</button></section>;
  return <section className="paraview-demo loading"><Waves size={38} /><strong>Opening simulation…</strong><span>{source.label}</span></section>;
}
