export class WorkerError extends Error {
  constructor(message, code = "worker_error") {
    super(message);
    this.name = "WorkerError";
    this.code = code;
  }
}
export function staleSession(id) {
  return new WorkerError(`unknown or closed CAD worker session: ${id}`, "invalid_session");
}
