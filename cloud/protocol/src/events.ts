// Per-user push events from the platform API (GET /v1/events). The desktop client parses these
// from JSON text, so the fields here are what the server sends.
export type UserEvent =
  | { type: "workspace_state"; state: string }
  | { type: "idle_warning"; reclaimAt: string }
  | { type: "reclaimed" };
