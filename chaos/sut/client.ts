import { get, post } from "./http.ts";
import type { Snapshot } from "./server.ts";

/** Thin API client used by both Actions and Invariants. */
export class ControlPlaneClient {
  constructor(readonly baseUrl: string) {}

  health() {
    return get<{ ok: boolean }>(`${this.baseUrl}/health`);
  }

  snapshot(): Promise<Snapshot> {
    return get<Snapshot>(`${this.baseUrl}/api/snapshot`);
  }

  reset() {
    return post(`${this.baseUrl}/api/reset`);
  }

  createProject(name = "chaos-project") {
    return post<{ projectId: string }>(`${this.baseUrl}/api/projects`, { name });
  }

  createRun(projectId: string) {
    return post<{ runId: string }>(`${this.baseUrl}/api/runs`, { projectId });
  }

  startRun(runId: string) {
    return post(`${this.baseUrl}/api/runs/${runId}/start`);
  }

  stopRun(runId: string) {
    return post(`${this.baseUrl}/api/runs/${runId}/stop`);
  }

  cancelRun(runId: string) {
    return post(`${this.baseUrl}/api/runs/${runId}/cancel`);
  }

  refreshRun(runId: string) {
    return post(`${this.baseUrl}/api/runs/${runId}/refresh`);
  }

  continueRun(runId: string) {
    return post<{ runId: string; created: boolean }>(`${this.baseUrl}/api/runs/${runId}/continue`);
  }

  uiState(runId: string) {
    return get<{ status: string; workerActive: boolean; activeWorkerCount: number }>(
      `${this.baseUrl}/api/runs/${runId}/ui`,
    );
  }

  /** Escape hatch for new endpoints before a typed helper exists. */
  request<T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    return (method === "GET" ? get<T>(`${this.baseUrl}${path}`) : post<T>(`${this.baseUrl}${path}`, body)) as Promise<T>;
  }
}
