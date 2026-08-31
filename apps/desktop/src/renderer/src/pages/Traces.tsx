import { useEffect, useMemo, useState } from "react";
import { Bot, Check, ChevronRight, FlaskConical, Search, Sparkles, Wrench } from "../components/icons";
import type { DistillationStatus, TraceSummary } from "@shared/contracts";

export function Traces() {
  const [items, setItems] = useState<TraceSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<TraceSummary | null>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [query, setQuery] = useState("");
  const [distill, setDistill] = useState<DistillationStatus>({ state: "idle", processed: 0, total: 0 });
  const [quality, setQuality] = useState(4);
  const [difficulty, setDifficulty] = useState(3);
  useEffect(() => { void window.piCad.traces.list().then(setItems); return window.piCad.traces.onDistillation(setDistill); }, []);
  const filtered = useMemo(() => items.filter((item) => `${item.title} ${item.model}`.toLowerCase().includes(query.toLowerCase())), [items, query]);
  const open = async (item: TraceSummary) => { setActive(item); setEntries(await window.piCad.traces.read(item.path)); };
  const toggle = (id: string) => setSelected((values) => values.includes(id) ? values.filter((item) => item !== id) : [...values, id]);
  const startDistill = async () => { const paths = items.filter((item) => selected.includes(item.id)).map((item) => item.path); setDistill(await window.piCad.traces.distill(paths, { quality, difficulty })); };
  return <div className="traces-page" data-testid="traces-page">
    <aside className="trace-list"><header><span>Experience</span><h1>Trajectories</h1><div className="search-box"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs" /></div></header><div className="trace-scroll">{filtered.map((item) => <div className={`trace-row ${active?.id === item.id ? "active" : ""}`} key={item.id}><button className={`trace-check ${selected.includes(item.id) ? "selected" : ""}`} onClick={() => toggle(item.id)}>{selected.includes(item.id) && <Check size={11} />}</button><button onClick={() => void open(item)}><strong>{item.title}</strong><span>{item.model || "Unknown model"}</span><small>{item.turns} events · {item.toolCalls} tools</small></button><ChevronRight size={14} /></div>)}</div><footer><div className="rating-row"><label>Quality<select value={quality} onChange={(event) => setQuality(Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option key={value}>{value}</option>)}</select></label><label>Difficulty<select value={difficulty} onChange={(event) => setDifficulty(Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option key={value}>{value}</option>)}</select></label></div><button className="primary" disabled={!selected.length || distill.state === "running"} onClick={() => void startDistill()}><Sparkles size={15} />Distill {selected.length || "selected"}</button></footer></aside>
    <section className="trace-viewer">{active ? <><header><div><span>Processed trajectory</span><h2>{active.title}</h2></div><div className="trace-stats"><span>{active.model}</span><span>{active.tokens?.toLocaleString() || "—"} tokens</span><span>{new Date(active.updatedAt).toLocaleString()}</span></div></header><div className="trace-timeline">{entries.map((entry, index) => <TraceEntry entry={entry} key={entry.id || index} />)}</div></> : <div className="trace-empty"><FlaskConical size={28} /><h2>Select a trajectory</h2><p>Review the cleaned conversation, tool use, timing, and reusable experience.</p></div>}
      {distill.state !== "idle" && <div className={`distill-drawer ${distill.state}`}><div><Sparkles size={17} /><span><strong>{distill.state === "running" ? "Distilling experience" : "Distillation complete"}</strong><small>{distill.message}</small></span></div><div className="distill-progress"><i style={{ width: `${distill.total ? distill.processed / distill.total * 100 : 12}%` }} /></div></div>}
    </section>
  </div>;
}

function TraceEntry({ entry }: { entry: any }) {
  const message = entry.message || entry;
  if (message.role === "user") return <article className="trace-entry user"><span>User</span><p>{contentText(message.content)}</p></article>;
  if (message.role === "assistant") return <article className="trace-entry assistant"><span><Bot size={13} />Agent</span><p>{contentText(message.content)}</p></article>;
  if (message.role === "toolResult") return <article className="trace-entry tool"><span><Wrench size={13} />{message.toolName || "Tool"}</span><p>{contentText(message.content).slice(0, 500)}</p></article>;
  return null;
}

function contentText(value: unknown): string { return typeof value === "string" ? value : Array.isArray(value) ? value.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n") : ""; }
