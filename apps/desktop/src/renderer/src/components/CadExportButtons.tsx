import type { CadTransferJob, CadTransferTarget } from "@shared/contracts";
import { TARGET_NAME, WORKBENCH_TEXT } from "@shared/cad-transfer-guide";
import { useCadTransfer } from "../hooks/useCadTransfer";
import { useState } from "react";

/** "Export to Fusion" and "Export to SolidWorks" for the current part. */
export function CadExportButtons({ artifact, onOpenSettings }: { artifact?: string; onOpenSettings: () => void }) {
  const { status, jobs } = useCadTransfer();
  const [active, setActive] = useState<Partial<Record<CadTransferTarget, string>>>({});
  const [startError, setStartError] = useState("");
  if (!artifact || !status) return null;
  const targets = (["fusion", "solidworks"] as const).filter((target) => status.targets[target].visible && status.targets[target].state !== "unsupported_platform");
  if (!targets.length) return null;
  const start = async (target: CadTransferTarget) => {
    setStartError("");
    try { const job = await window.piCad.cadTransfer.exportPart(target, artifact); setActive((current) => ({ ...current, [target]: job.jobId })); }
    catch (e) { setStartError(String(e)); }
  };
  return <div className="cad-export-buttons" data-testid="cad-export-buttons">
    {targets.map((target) => {
      const info = status.targets[target];
      const job: CadTransferJob | undefined = active[target] ? jobs[active[target]!] : undefined;
      const working = job?.state === "queued" || job?.state === "running";
      const ready = info.state === "ready";
      const label = target === "fusion" ? WORKBENCH_TEXT.exportFusion : WORKBENCH_TEXT.exportSolidworks;
      return <span key={target} className="cad-export">
        <button disabled={!ready || working} title={ready ? label : WORKBENCH_TEXT.disabledTitle(TARGET_NAME[target], info.detail)} onClick={() => void start(target)}>{label}</button>
        {!ready && <button className="link" onClick={onOpenSettings}>{WORKBENCH_TEXT.setupLink}</button>}
        {working && <><small role="status">{job.message}</small><button onClick={() => void window.piCad.cadTransfer.cancel(job.jobId)}>{WORKBENCH_TEXT.cancel}</button></>}
        {job?.state === "done" && <><small role="status">{job.native}</small><button onClick={() => void window.piCad.cadTransfer.openFolder(target, job.nativeFolder)}>{WORKBENCH_TEXT.openFolder}</button></>}
        {(job?.state === "failed" || job?.state === "cancelled") && <small role="alert" className="cad-export-error">{job.message}</small>}
      </span>;
    })}
    {startError && <small role="alert">{startError}</small>}
  </div>;
}
