import { useCallback, useEffect, useState } from "react";
import type { CloudStatus } from "@shared/contracts";
import { dismissCloudNotice, initialCloudView, reduceCloudEvent, type CloudView } from "../lib/cloud-state";

/** Cloud status and its pushed events. Each consumer subscribes on its own; the reads are cheap. */
export function useCloud() {
  const [view, setView] = useState<CloudView>(initialCloudView);

  const refresh = useCallback(async () => {
    const status = await window.piCad.cloud.status();
    setView((current) => ({ ...current, status }));
    return status;
  }, []);

  const setStatus = useCallback((status: CloudStatus) => setView((current) => ({ ...current, status })), []);

  const dismiss = useCallback((notice: "idle" | "reclaimed") => setView((current) => dismissCloudNotice(current, notice)), []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    return window.piCad.cloud.onEvent((event) => setView((current) => reduceCloudEvent(current, event)));
  }, [refresh]);

  return { view, refresh, setStatus, dismiss };
}
