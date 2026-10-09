import { useState } from "react";
import type { CloudView } from "../lib/cloud-state";
import { cloudErrorMessage } from "../lib/cloud-state";

/**
 * Workspace notices: the idle warning (keep working), the reclaim notice (reconnect),
 * and the reconnecting banner while the bridge is down.
 */
export function CloudNotices({ view, onDismiss, onReconnect }: { view: CloudView; onDismiss: (notice: "idle" | "reclaimed") => void; onReconnect: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keepWorking = async () => {
    setError("");
    try {
      await window.piCad.cloud.keepalive();
      onDismiss("idle");
    } catch (reason) {
      setError(cloudErrorMessage(reason));
    }
  };
  const reconnect = async () => {
    setBusy(true);
    setError("");
    try {
      await onReconnect();
      onDismiss("reclaimed");
    } catch (reason) {
      setError(cloudErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return <>
    {view.bridge === "reconnecting" && <div className="cloud-banner" role="status">正在重新连接服务器…</div>}
    {view.idleWarning && <div className="cloud-dialog" role="alertdialog" aria-labelledby="cloud-idle-title">
      <p id="cloud-idle-title">5 分钟后将暂停工作区。</p>
      <div>
        <button className="primary" onClick={() => void keepWorking()}>继续工作</button>
      </div>
    </div>}
    {view.reclaimed && <div className="cloud-banner" role="status">
      <span>工作区已暂停。文件和工作流已保存，Python 变量未保留。</span>
      <button onClick={() => void reconnect()} disabled={busy}>{busy ? "正在重新连接…" : "重新连接"}</button>
    </div>}
    {error && <div className="cloud-banner" role="alert">{error}</div>}
  </>;
}
