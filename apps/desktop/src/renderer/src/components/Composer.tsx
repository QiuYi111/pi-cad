import { ArrowUp, Box, Plus, ShieldCheck, Sparkles, Square } from "./icons";
import { useEffect, useRef, useState } from "react";
import type { AppSettings, RuntimeStatus, ThinkingLevel } from "@shared/contracts";

const models = ["gpt-5.6-sol", "gpt-5.6-luna"];
const efforts: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

type PendingRequest = { id: string; text: string };
type RunningIntent = "queue" | "replace" | "note";

export function Composer({ settings, status, queueKey, onSettingsChange, onSend, onNote, onAbort, onDraftChange, onImagesAdded }: { settings: AppSettings; status: RuntimeStatus; queueKey: string; onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>; onSend: (text: string, images?: Array<{ data: string; mimeType: string }>) => Promise<void>; onNote: (text: string) => void; onAbort: () => Promise<void>; onDraftChange?: (hasDraft: boolean) => void; onImagesAdded?: (images: Array<{ name: string; data: string; mimeType: string }>) => void }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<{ name: string; data: string; mimeType: string }>>([]);
  const [availableModels, setAvailableModels] = useState(models);
  const [attachmentError, setAttachmentError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [runningIntent, setRunningIntent] = useState<RunningIntent>("queue");
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const imagesByConversation = useRef<Record<string, Array<{ name: string; data: string; mimeType: string }>>>({});
  const activeImageKey = useRef(queueKey);
  const imagesRef = useRef(images);
  const draining = useRef(false);
  const loadingQueue = useRef(false);
  const streaming = status.state === "streaming";
  const starting = status.state === "starting";
  useEffect(() => {
    if (status.state !== "ready") return;
    void window.piCad.runtime.getModels().then((choices) => {
      const ids = choices.filter((choice) => choice.provider === settings.provider).map((choice) => choice.id);
      if (ids.length) setAvailableModels(ids);
    }).catch(() => undefined);
  }, [status.state, settings.provider]);
  const storageKey = `reify.pending.${queueKey || "unconfigured"}`;
  const draftKey = `reify.draft.${queueKey || "unconfigured"}`;
  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => {
    imagesByConversation.current[activeImageKey.current] = imagesRef.current;
    activeImageKey.current = queueKey;
    setImages(imagesByConversation.current[queueKey] || []);
    setAttachmentError("");
  }, [queueKey]);
  useEffect(() => {
    const saved = localStorage.getItem(draftKey) || "";
    setText(saved);
    onDraftChange?.(Boolean(saved));
  }, [draftKey]);
  useEffect(() => {
    loadingQueue.current = true;
    try { setPending(JSON.parse(localStorage.getItem(storageKey) || "[]")); }
    catch { setPending([]); }
  }, [storageKey]);
  useEffect(() => {
    if (loadingQueue.current) { loadingQueue.current = false; return; }
    localStorage.setItem(storageKey, JSON.stringify(pending));
  }, [storageKey, pending]);
  useEffect(() => {
    if (status.state !== "ready" || !pending.length || draining.current) return;
    const request = pending[0]!;
    draining.current = true;
    void onSend(`[Queued request ${request.id}] ${request.text}`).finally(() => {
      setPending((current) => current.filter((item) => item.id !== request.id));
      draining.current = false;
    });
  }, [status.state, pending, onSend]);
  const send = async () => {
    const value = text.trim();
    if (!value || starting) return;
    setText("");
    localStorage.removeItem(draftKey);
    onDraftChange?.(false);
    const attached = images.map(({ data, mimeType }) => ({ data, mimeType }));
    setImages([]);
    if (streaming) {
      if (runningIntent === "note") onNote(value);
      else if (runningIntent === "queue") setPending((current) => [...current, { id: crypto.randomUUID(), text: value }]);
      else {
        await abort();
        setPending((current) => [{ id: crypto.randomUUID(), text: value }, ...current]);
      }
      return;
    }
    try { await onSend(value, attached); }
    catch { /* The conversation renders the runtime error. */ }
  };
  const attach = async () => {
    setAttachmentError("");
    try {
      const chosen = await window.piCad.runtime.chooseImages();
      setImages((current) => [...current, ...chosen]);
      onImagesAdded?.(chosen);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  };
  const changeModel = async (model: string) => {
    await onSettingsChange({ model });
    if (status.state === "ready" || status.state === "streaming") await window.piCad.runtime.setModel(settings.provider, model);
  };
  const changeThinking = async (thinking: ThinkingLevel) => {
    await onSettingsChange({ thinking });
    if (status.state === "ready" || status.state === "streaming") await window.piCad.runtime.setThinking(thinking);
  };
  const changePermission = async (permission: AppSettings["permission"]) => {
    if (status.state === "ready" || status.state === "streaming") await window.piCad.runtime.stop();
    await onSettingsChange({ permission });
  };
  const abort = async () => {
    if (stopping) return;
    setStopping(true);
    setAttachmentError("");
    try { await onAbort(); }
    catch (error) {
      setAttachmentError(`Could not confirm that the task stopped. ${error instanceof Error ? error.message : String(error)}`);
    }
    finally { setStopping(false); }
  };
  return <div className="composer" data-testid="composer">
    {attachmentError && <div className="composer-error" role="alert">{attachmentError}</div>}
    {images.length > 0 && <div className="composer-attachments">{images.map((image, index) => <button key={`${image.name}-${index}`} onClick={() => setImages((current) => current.filter((_, item) => item !== index))} title="Remove image"><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} /><span>{image.name}</span></button>)}</div>}
    {pending.length > 0 && <div className="pending-requests" role="region" aria-label="Pending requests"><strong>After current task</strong>{pending.map((request) => <div key={request.id}><input aria-label={`Queued request ${request.id}`} value={request.text} onChange={(event) => setPending((current) => current.map((item) => item.id === request.id ? { ...item, text: event.target.value } : item))} /><button aria-label={`Cancel queued request ${request.id}`} onClick={() => setPending((current) => current.filter((item) => item.id !== request.id))}>Cancel</button></div>)}</div>}
    <textarea value={text} onChange={(event) => { setText(event.target.value); localStorage.setItem(draftKey, event.target.value); onDraftChange?.(Boolean(event.target.value)); }} onKeyDown={(event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
    }} placeholder="Ask anything about the design" aria-label="Message" />
    <div className="composer-controls">
      <button className="round-button" aria-label="Attach" onClick={() => void attach()}><Plus size={18} /></button>
      {streaming && <label className="composer-chip">Send as<select aria-label="Running request action" value={runningIntent} onChange={(event) => setRunningIntent(event.target.value as RunningIntent)}><option value="queue">After current task</option><option value="replace">Stop and modify</option><option value="note">Note only</option></select></label>}
      <label className="composer-chip"><ShieldCheck size={14} /><select aria-label="Permission" value={settings.permission} onChange={(event) => void changePermission(event.target.value as AppSettings["permission"])}><option value="workspace">Workspace</option><option value="read-only">Read only</option></select></label>
      <label className="composer-chip"><Box size={14} /><select aria-label="Model" value={settings.model} onChange={(event) => void changeModel(event.target.value)}>{[...new Set([settings.model, ...availableModels])].map((model) => <option key={model} value={model}>{shortModel(model)}</option>)}</select></label>
      <label className="composer-chip"><Sparkles size={14} /><select aria-label="Effort" value={settings.thinking} onChange={(event) => void changeThinking(event.target.value as ThinkingLevel)}>{efforts.map((level) => <option key={level}>{level}</option>)}</select></label>
      <span className="composer-spacer" />
      <button className={`send-button ${starting || stopping || (streaming && !text.trim()) ? "busy" : ""}`} onClick={() => streaming && !text.trim() ? void abort() : void send()} aria-label={stopping ? "Stopping" : streaming && !text.trim() ? "Stop" : streaming ? runningIntent === "queue" ? "Queue request" : runningIntent === "replace" ? "Stop and modify" : "Save note" : "Send"} disabled={starting || stopping}>
        {streaming && !text.trim() ? <><Square size={13} fill="currentColor" />{stopping && <span>Stopping…</span>}</> : <ArrowUp size={18} />}
      </button>
    </div>
  </div>;
}

function shortModel(model: string) { return model.replace(/^gpt-5\.6-/, "").replace(/^gpt-/, "GPT "); }
