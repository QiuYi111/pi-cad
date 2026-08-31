import { EventEmitter } from "node:events";
import type { AppSettings, ModelChoice, RuntimeStatus, ThinkingLevel } from "../../src/shared/contracts.js";

const wait = (ms: number) => new Promise((accept) => setTimeout(accept, ms));

export class DemoRuntime extends EventEmitter {
  status: RuntimeStatus = { state: "idle", checks: [] };

  async start(_settings: AppSettings) {
    this.status = { state: "ready", checks: [], sessionId: "desktop-e2e" };
    this.emit("status", this.status);
    return this.status;
  }
  async stop() { this.status = { state: "idle", checks: [] }; this.emit("status", this.status); }
  async abort() { this.status = { ...this.status, state: "ready" }; this.emit("status", this.status); }
  async getModels(): Promise<ModelChoice[]> { return [{ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true }]; }
  async setModel(_provider: string, _model: string) {}
  async setThinking(_level: ThinkingLevel) {}
  async respondToUi(_id: string, _response: Record<string, unknown>) {}

  async prompt(message: string) {
    this.status = { ...this.status, state: "streaming" };
    this.emit("status", this.status);
    this.emit("event", { type: "message_start", message: { role: "user", content: message, id: "demo-user" } });
    this.emit("event", { type: "agent_start" });
    this.emit("event", { type: "message_update", message: { role: "assistant", id: "demo-assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking requirements" } });
    await wait(80);
    this.emit("event", { type: "tool_execution_start", toolCallId: "demo-build", toolName: "ipython", args: { code: "artifact = await cad.model.build('part.py', 'part.step')" } });
    await wait(120);
    this.emit("event", {
      type: "tool_execution_end", toolCallId: "demo-build", toolName: "ipython",
      result: { content: [{ type: "text", text: "ArtifactRef(role='candidate', path='build/part.step')" }], details: { attachments: [{ mimeType: "image/png", role: "isometric", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] } },
    });
    this.emit("event", { type: "tool_execution_start", toolCallId: "demo-workflow", toolName: "ipython", args: { code: "await cad.workflow.advance('built')" } });
    this.emit("event", { type: "tool_execution_end", toolCallId: "demo-workflow", result: { content: [{ type: "text", text: "Commit(id='commit-dd03e58b622007c794189ba3c99ac2', name='review-candidate', phase='parts', variables=8, artifacts=2) final_review" }] } });
    for (const delta of ["The first model ", "is built and ready ", "for inspection."]) this.emit("event", { type: "message_update", message: { role: "assistant", id: "demo-assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
    this.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The first model is built and ready for inspection." }], id: "demo-assistant" } });
    this.emit("event", { type: "agent_end" });
    this.status = { ...this.status, state: "ready" };
    this.emit("status", this.status);
  }
}
