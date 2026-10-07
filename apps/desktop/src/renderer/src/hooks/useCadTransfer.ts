import { useCallback, useEffect, useState } from "react";
import type { CadTransferJob, CadTransferStatus } from "@shared/contracts";

/** Status of the CAD exports and the latest job of each id. Refreshes every 5 s while mounted. */
export function useCadTransfer(pollMs = 5000) {
  const [status, setStatus] = useState<CadTransferStatus | null>(null);
  const [jobs, setJobs] = useState<Record<string, CadTransferJob>>({});
  const [error, setError] = useState("");
  const refresh = useCallback(async (force = false) => {
    try { setStatus(await window.piCad.cadTransfer.status(force)); setError(""); }
    catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => {
    void refresh(true);
    const timer = setInterval(() => void refresh(), pollMs);
    const off = window.piCad.cadTransfer.onEvent((event) => {
      if (event.type === "status") setStatus(event.status);
      else setJobs((current) => ({ ...current, [event.job.jobId]: event.job }));
    });
    return () => { clearInterval(timer); off(); };
  }, [refresh, pollMs]);
  return { status, jobs, error, refresh, setStatus, setJobs };
}
