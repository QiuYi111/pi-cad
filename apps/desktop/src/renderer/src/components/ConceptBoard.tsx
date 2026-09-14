import { useMemo, useRef, useState } from "react";
import type { MediaAttachment } from "@shared/contracts";

export interface ConceptImage extends MediaAttachment {
  version: number;
  origin: "uploaded" | "generated";
}

export interface ConceptSelection { x: number; y: number; width: number; height: number }

export function ConceptBoard({ images, onContinue }: { images: ConceptImage[]; onContinue: (image: ConceptImage, note: string, selection?: ConceptSelection) => Promise<void> }) {
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState(images.at(-1)?.id || "");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [selections, setSelections] = useState<Record<string, ConceptSelection>>({});
  const [outdated, setOutdated] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ id: string; x: number; y: number } | null>(null);
  const active = useMemo(() => images.find((image) => image.id === selected) ?? images.at(-1), [images, selected]);
  const point = (event: React.PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  };
  const finishSelection = (event: React.PointerEvent<HTMLElement>, image: ConceptImage) => {
    const start = drag.current;
    if (!start || start.id !== image.id) return;
    const end = point(event);
    const selection = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
    if (selection.width > .01 && selection.height > .01) setSelections((current) => ({ ...current, [image.id]: selection }));
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  if (!images.length) return null;
  return <section className="concept-board" aria-label="Concept board">
    <header><div><small>Concept board</small><strong>{images.length} direction{images.length === 1 ? "" : "s"}</strong></div><span /><button onClick={() => setZoom((value) => Math.max(.5, value - .15))} aria-label="Zoom out">−</button><output>{Math.round(zoom * 100)}%</output><button onClick={() => setZoom((value) => Math.min(2.5, value + .15))} aria-label="Zoom in">+</button><button onClick={() => setZoom(1)}>Fit</button></header>
    <div className="concept-board-scroll">
      <div className="concept-grid" style={{ "--concept-zoom": zoom } as React.CSSProperties}>
        {images.map((image) => {
          const selection = selections[image.id];
          const source = image.dataUrl || (image.path ? `file://${image.path}` : "");
          return <article key={image.id} className={`${selected === image.id ? "selected" : ""} ${outdated.has(image.id) ? "outdated" : ""}`}>
            <button className="concept-image" onClick={() => setSelected(image.id)} onPointerDown={(event) => { const start = point(event); drag.current = { id: image.id, ...start }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerUp={(event) => finishSelection(event, image)}>
              <img src={source} alt={image.label || image.role || `Concept ${image.version}`} draggable={false} />
              {selection && <i className="concept-selection" style={{ left: `${selection.x * 100}%`, top: `${selection.y * 100}%`, width: `${selection.width * 100}%`, height: `${selection.height * 100}%` }} />}
            </button>
            <div className="concept-meta"><span>V{image.version} · {image.origin}</span><strong>{image.label || image.role || "Concept direction"}</strong></div>
            <textarea aria-label={`Annotation for concept ${image.version}`} value={notes[image.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [image.id]: event.target.value }))} placeholder="Add design notes…" />
            <footer><button onClick={() => setOutdated((current) => { const next = new Set(current); next.has(image.id) ? next.delete(image.id) : next.add(image.id); return next; })}>{outdated.has(image.id) ? "Restore" : "Mark outdated"}</button><button className="primary" disabled={busy || outdated.has(image.id)} onClick={async () => { setSelected(image.id); setBusy(true); try { await onContinue(image, notes[image.id] || "", selection); } finally { setBusy(false); } }}>Use this direction</button></footer>
          </article>;
        })}
      </div>
    </div>
    {active && <footer className="concept-board-status">Selected V{active.version}{selections[active.id] ? " · region selected" : " · full image"}</footer>}
  </section>;
}
