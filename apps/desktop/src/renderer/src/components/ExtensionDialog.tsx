import { useEffect, useState } from "react";
import type { ExtensionUiRequest } from "@shared/contracts";

export function ExtensionDialog() {
  const [request, setRequest] = useState<ExtensionUiRequest | null>(null);
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => window.piCad.runtime.onUiRequest((next) => {
    if (next.method === "notify" || next.method === "setStatus") {
      setNotice(String((next as any).message || (next as any).text || ""));
      window.setTimeout(() => setNotice(""), 4500);
      return;
    }
    if (next.method === "setTitle" || next.method === "setWidget" || next.method === "set_editor_text") return;
    setValue("prefill" in next ? String(next.prefill || "") : "");
    setRequest(next);
  }), []);
  const finish = async (response: Record<string, unknown>) => {
    if (!request) return;
    await window.piCad.runtime.respondToUi(request.id, response);
    setRequest(null);
  };
  return <>
    {notice && <div className="extension-notice">{notice}</div>}
    {request && <div className="modal-backdrop" role="presentation">
      <section className="extension-dialog" role="dialog" aria-modal="true">
        <span className="eyebrow">Prime needs your input</span>
        <h2>{String(request.title || "Prime Agent")}</h2>
        {request.method === "confirm" && <p>{request.message}</p>}
        {request.method === "select" && <div className="dialog-options">{request.options.map((option) => <button key={option} onClick={() => void finish({ value: option })}>{option}</button>)}</div>}
        {(request.method === "input" || request.method === "editor") && (request.method === "editor"
          ? <textarea autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />
          : <input autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void finish({ value }); }} />)}
        <footer>
          <button onClick={() => void finish({ cancelled: true })}>Cancel</button>
          {request.method === "confirm" && <><button onClick={() => void finish({ value: false })}>No</button><button className="primary" onClick={() => void finish({ value: true })}>Confirm</button></>}
          {(request.method === "input" || request.method === "editor") && <button className="primary" onClick={() => void finish({ value })}>Continue</button>}
        </footer>
      </section>
    </div>}
  </>;
}
