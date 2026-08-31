import { ArrowUp, Box, Plus, ShieldCheck, Sparkles, Square } from "./icons";
import { useState } from "react";
import type { AppSettings, RuntimeStatus, ThinkingLevel } from "@shared/contracts";

const models = ["gpt-5.6-sol", "gpt-5.6-luna"];
const efforts: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function Composer({ settings, status, onSettingsChange, onSend, onAbort }: { settings: AppSettings; status: RuntimeStatus; onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>; onSend: (text: string, images?: Array<{ data: string; mimeType: string }>) => Promise<void>; onAbort: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<{ name: string; data: string; mimeType: string }>>([]);
  const busy = status.state === "streaming" || status.state === "starting";
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    const attached = images.map(({ data, mimeType }) => ({ data, mimeType }));
    setImages([]);
    await onSend(value, attached);
  };
  const attach = async () => {
    const chosen = await window.piCad.runtime.chooseImages();
    setImages((current) => [...current, ...chosen]);
  };
  const changeModel = async (model: string) => {
    await onSettingsChange({ model });
    if (status.state === "ready" || status.state === "streaming") await window.piCad.runtime.setModel(settings.provider, model);
  };
  const changeThinking = async (thinking: ThinkingLevel) => {
    await onSettingsChange({ thinking });
    if (status.state === "ready" || status.state === "streaming") await window.piCad.runtime.setThinking(thinking);
  };
  return <div className="composer" data-testid="composer">
    {images.length > 0 && <div className="composer-attachments">{images.map((image, index) => <button key={`${image.name}-${index}`} onClick={() => setImages((current) => current.filter((_, item) => item !== index))} title="Remove image"><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} /><span>{image.name}</span></button>)}</div>}
    <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
    }} placeholder="Ask anything about the design" aria-label="Message" />
    <div className="composer-controls">
      <button className="round-button" aria-label="Attach" onClick={() => void attach()}><Plus size={18} /></button>
      <label className="composer-chip"><ShieldCheck size={14} /><select aria-label="Permission" value={settings.permission} onChange={(event) => void onSettingsChange({ permission: event.target.value as AppSettings["permission"] })}><option value="workspace">Workspace</option><option value="read-only">Read only</option></select></label>
      <label className="composer-chip"><Box size={14} /><select aria-label="Model" value={settings.model} onChange={(event) => void changeModel(event.target.value)}>{[...new Set([settings.model, ...models])].map((model) => <option key={model} value={model}>{shortModel(model)}</option>)}</select></label>
      <label className="composer-chip"><Sparkles size={14} /><select aria-label="Effort" value={settings.thinking} onChange={(event) => void changeThinking(event.target.value as ThinkingLevel)}>{efforts.map((level) => <option key={level}>{level}</option>)}</select></label>
      <span className="composer-spacer" />
      <button className={`send-button ${busy ? "busy" : ""}`} onClick={() => busy ? void onAbort() : void send()} aria-label={busy ? "Stop" : "Send"}>
        {busy ? <Square size={13} fill="currentColor" /> : <ArrowUp size={18} />}
      </button>
    </div>
  </div>;
}

function shortModel(model: string) { return model.replace(/^gpt-5\.6-/, "").replace(/^gpt-/, "GPT "); }
