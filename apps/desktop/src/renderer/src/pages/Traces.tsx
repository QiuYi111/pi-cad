import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronRight, FlaskConical, Search, Sparkles, Wrench } from "../components/icons";
import type { DistillationStatus, RatingStatus, TraceSummary } from "@shared/contracts";
import { distillationTitle } from "../lib/distillation";

export function Traces() {
  const [items, setItems] = useState<TraceSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<TraceSummary | null>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [query, setQuery] = useState("");
  const [distill, setDistill] = useState<DistillationStatus>({ state: "idle", processed: 0, total: 0 });
  const [quality, setQuality] = useState(4);
  const [difficulty, setDifficulty] = useState(3);
  const [feedback, setFeedback] = useState("");
  const [rating, setRating] = useState<RatingStatus | null>(null);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [entryState, setEntryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const openRequest = useRef(0);
  useEffect(() => {
    let alive = true;
    void window.piCad.traces.list().then((next) => { if (alive) { setItems(next); setListState("ready"); } }).catch(() => { if (alive) setListState("error"); });
    const off = window.piCad.traces.onDistillation(setDistill);
    return () => { alive = false; openRequest.current += 1; off(); };
  }, []);
  const filtered = useMemo(() => items.filter((item) => `${item.title} ${item.model}`.toLowerCase().includes(query.toLowerCase())), [items, query]);
  const open = async (item: TraceSummary) => {
    const request = ++openRequest.current;
    setActive(item);
    setSelected((values) => values.includes(item.id) ? values : [...values, item.id]);
    setEntryState("loading");
    try {
      const next = await window.piCad.traces.read(item.path);
      if (request === openRequest.current) { setEntries(next); setEntryState("ready"); }
    } catch {
      if (request === openRequest.current) { setEntries([]); setEntryState("error"); }
    }
  };
  const toggle = (id: string) => setSelected((values) => values.includes(id) ? values.filter((item) => item !== id) : [...values, id]);
  const startDistill = async () => {
    const paths = items.filter((item) => selected.includes(item.id)).map((item) => item.path);
    try { setDistill(await window.piCad.traces.distill(paths, { quality, difficulty })); }
    catch (error) { setDistill({ state: "failed", processed: 0, total: paths.length, message: error instanceof Error ? error.message : String(error) }); }
  };
  const rateSelected = async () => {
    const paths = items.filter((item) => selected.includes(item.id)).map((item) => item.path);
    setRatingBusy(true);
    setRating({ rated: 0, triggered: false, pendingTokens: 0, thresholdTokens: 0, message: "Saving rating and preparing the trajectory…" });
    try {
      setRating(await window.piCad.traces.rate(paths, { quality, difficulty, feedback }));
      setItems(await window.piCad.traces.list());
    } catch (error) {
      setRating({ rated: 0, triggered: false, pendingTokens: 0, thresholdTokens: 0, message: `Rating failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally { setRatingBusy(false); }
  };
  return <div className="traces-page" data-testid="traces-page">
    <aside className="trace-list"><header><span>Experience</span><h1>Trajectories</h1><div className="search-box"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs" /></div></header><div className="trace-scroll">{listState === "loading" ? <p className="trace-list-state">Loading trajectories…</p> : listState === "error" ? <p className="trace-list-state" role="alert">Could not load trajectories.</p> : filtered.length ? filtered.map((item) => <div className={`trace-row ${active?.id === item.id ? "active" : ""}`} key={item.id}><button aria-label={`Select ${item.title} for rating`} className={`trace-check ${selected.includes(item.id) ? "selected" : ""}`} onClick={() => toggle(item.id)}>{selected.includes(item.id) && <Check size={11} />}</button><button onClick={() => void open(item)}><strong>{item.title}</strong><span>{item.model || "Unknown model"}</span><small>{item.turns} events · {item.toolCalls} tools · {item.evaluation ? `${item.evaluation.quality}/5` : "Unrated"}</small></button><ChevronRight size={14} /></div>) : <p className="trace-list-state">{query ? "No matching trajectories." : "No trajectories yet."}</p>}</div><footer className={ratingOpen ? "open" : ""}><button className="rating-toggle" aria-expanded={ratingOpen} onClick={() => setRatingOpen((open) => !open)}>{selected.length ? `${selected.length} selected` : "Select runs to rate"}<ChevronRight size={14} /></button>{ratingOpen && <div className="rating-panel"><div className="rating-row"><label>Quality<select value={quality} onChange={(event) => setQuality(Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option key={value}>{value}</option>)}</select></label><label>Difficulty<select value={difficulty} onChange={(event) => setDifficulty(Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option key={value}>{value}</option>)}</select></label></div><textarea className="rating-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="What worked or failed?" /><div className="rating-actions"><button disabled={!selected.length || ratingBusy} onClick={() => void rateSelected()}>{ratingBusy ? "Saving…" : `Rate ${selected.length || "selected"}`}</button><button className="primary" disabled={!selected.length || distill.state === "running"} onClick={() => void startDistill()}><Sparkles size={15} />Distill now</button></div>{rating && <small className="rating-status">{rating.message}</small>}</div>}</footer></aside>
    <section className="trace-viewer">{active ? <><header><div><span>Processed trajectory</span><h2>{active.title}</h2></div><div className="trace-stats"><span>{active.model}</span><span>{active.tokens?.toLocaleString() || "—"} tokens</span><span>{new Date(active.updatedAt).toLocaleString()}</span></div></header><div className="trace-timeline">{entryState === "loading" ? <div className="trace-empty"><p>Loading trajectory…</p></div> : entryState === "error" ? <div className="trace-empty" role="alert"><p>Could not read this trajectory.</p></div> : entries.map((entry, index) => <TraceEntry entry={entry} key={entry.id || index} />)}</div></> : <div className="trace-empty"><FlaskConical size={28} /><h2>Select a trajectory</h2><p>Review the cleaned conversation, tool use, timing, and reusable experience.</p></div>}
      {distill.state !== "idle" && <div className={`distill-drawer ${distill.state}`}><div><Sparkles size={17} /><span><strong>{distillationTitle(distill.state)}</strong><small>{distill.message}</small>{distill.state === "candidate" && <><small>Sources: {distill.sourceFailureSeqs?.join(", ") || "—"} · changed: {distill.changedFiles?.join(", ") || "none"} · validation: {distill.validationStatus}</small>{distill.jobPath && <span><button onClick={async () => { try { await window.piCad.traces.validateCandidate(distill.jobPath!); setDistill((value) => ({ ...value, validationStatus: "passed", message: "Engineering replay passed. Review metrics before adoption." })); } catch (error) { setDistill((value) => ({ ...value, validationStatus: "failed", message: String(error) })); } }}>Validate replay</button><button disabled={distill.validationStatus !== "passed"} onClick={async () => { try { const result = await window.piCad.traces.adoptCandidate(distill.jobPath!); setDistill((value) => ({ ...value, state: "complete", message: `Adopted fixed rule version ${(result as any).version}. Existing runs remain pinned.` })); } catch (error) { setDistill((value) => ({ ...value, state: "failed", message: String(error) })); } }}>Approve and adopt</button></span>}</>}</span></div><div className="distill-progress"><i style={{ width: `${distill.total ? distill.processed / distill.total * 100 : 12}%` }} /></div></div>}
    </section>
  </div>;
}

function TraceEntry({ entry }: { entry: any }) {
  const [expanded, setExpanded] = useState(false);
  const message = entry.message || entry;
  if (message.role === "user") return <article className="trace-entry user"><span>User</span><p>{contentText(message.content)}</p></article>;
  if (message.role === "assistant") return <article className="trace-entry assistant"><span><Bot size={13} />Agent</span><p>{contentText(message.content)}</p></article>;
  if (message.role === "toolResult") {
    const text = contentText(message.content);
    const clipped = text.length > 500;
    return <article className="trace-entry tool"><span><Wrench size={13} />{message.toolName || "Tool"}</span><p>{expanded ? text : text.slice(0, 500)}</p>{clipped && <button onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "Show full result"}</button>}</article>;
  }
  return null;
}

function contentText(value: unknown): string { return typeof value === "string" ? value : Array.isArray(value) ? value.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n") : ""; }
