import { EventEmitter } from "node:events";
import type { AppSettings, ModelChoice, RuntimeStatus, ThinkingLevel } from "../../src/shared/contracts.js";

const wait = (ms: number) => new Promise((accept) => setTimeout(accept, ms));

export class DemoRuntime extends EventEmitter {
  status: RuntimeStatus = { state: "idle", checks: [] };
  private generation = 0;
  private messages: unknown[] = [];

  async start(_settings: AppSettings) {
    this.status = { state: "starting", checks: [], message: "Starting Prime…" };
    this.emit("status", this.status);
    await wait(120);
    this.status = { state: "ready", checks: [], sessionId: "desktop-e2e" };
    this.emit("status", this.status);
    return this.status;
  }
  async stop() { this.status = { state: "idle", checks: [] }; this.emit("status", this.status); }
  async abort() {
    this.generation += 1;
    this.emit("event", { type: "agent_abort" });
    this.status = { ...this.status, state: "ready" };
    this.emit("status", this.status);
  }
  async steer(message: string) { this.emit("event", { type: "message_start", message: { role: "user", content: message } }); }
  async newSession() { this.messages = []; return []; }
  async switchSession(_path?: string) {
    this.messages = [
      { id: "demo-history-user", role: "user", content: "Design a folding stand" },
      { id: "demo-history-assistant", role: "assistant", content: "I checked the interfaces before building." },
    ];
    return this.messages;
  }
  async getMessages() { return this.messages; }
  async getModels(): Promise<ModelChoice[]> { return [
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true },
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true },
  ]; }
  async setModel(_provider: string, _model: string) {}
  async setThinking(_level: ThinkingLevel) {}
  async respondToUi(_id: string, _response: Record<string, unknown>) {}

  async prompt(message: string) {
    const generation = ++this.generation;
    this.messages.push({ id: `demo-user-${generation}`, role: "user", content: message });
    this.status = { ...this.status, state: "streaming" };
    this.emit("status", this.status);
    this.emit("event", { type: "message_start", message: { role: "user", content: message, id: "demo-user" } });
    this.emit("event", { type: "agent_start" });
    this.emit("event", { type: "message_update", message: { role: "assistant", id: "demo-assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking requirements" } });
    await wait(80);
    if (generation !== this.generation) return;
    if (/simulate interruption/i.test(message)) {
      this.emit("event", { type: "agent_abort" });
      this.status = { ...this.status, state: "error", message: "The demo worker exited unexpectedly." };
      this.emit("status", this.status);
      return;
    }
    if (/long calculation/i.test(message)) {
      this.emit("event", { type: "tool_execution_start", toolCallId: "demo-long", toolName: "ipython", args: { code: "run_long_calculation()" } });
      await wait(5_000);
      if (generation !== this.generation) return;
    }
    if (/generate concept/i.test(message)) {
      this.emit("event", { type: "tool_execution_start", toolCallId: "demo-concept", toolName: "codex_generate_image", args: { prompt: message } });
      await wait(80);
      if (generation !== this.generation) return;
      this.emit("event", { type: "tool_execution_end", toolCallId: "demo-concept", toolName: "codex_generate_image", result: { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", name: "Concept A" }] } });
      this.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Concept direction ready for selection." }], id: "demo-assistant" } });
      this.emit("event", { type: "agent_end" });
      this.messages.push({ id: `demo-assistant-${generation}`, role: "assistant", content: "Concept direction ready for selection." });
      this.status = { ...this.status, state: "ready" };
      this.emit("status", this.status);
      return;
    }
    if (/format response/i.test(message)) {
      this.emit("event", { type: "tool_execution_start", toolCallId: "demo-read", toolName: "read", args: { path: "requirements.md" } });
      await wait(80);
      if (generation !== this.generation) return;
      this.emit("event", { type: "tool_execution_end", toolCallId: "demo-read", result: { content: [{ type: "text", text: "读取完成" }] } });
      const content = "## 设计约束\n\n**重点尺寸**\n\n- 宽度 80 mm\n- 厚度 3 mm\n\n---\n\n| 项目 | 数值 |\n| --- | --- |\n| 倾角 | 65° |";
      this.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: content }], id: "demo-assistant" } });
      this.emit("event", { type: "agent_end" });
      this.messages.push({ id: `demo-assistant-${generation}`, role: "assistant", content });
      this.status = { ...this.status, state: "ready" };
      this.emit("status", this.status);
      return;
    }
    if (/simulation\/torch-fem-linear-elastic/i.test(message)) {
      this.emit("event", { type: "tool_execution_start", toolCallId: "demo-simulation-run", toolName: "ipython", args: { code: "await cad.simulation.run(recipe='simulation/torch-fem-linear-elastic')" } });
      await wait(800);
      if (generation !== this.generation) return;
      this.emit("event", { type: "tool_execution_update", toolCallId: "demo-simulation-run", stage: "Checking reaction balance and convergence", progress: .82 });
      this.emit("event", { type: "tool_execution_end", toolCallId: "demo-simulation-run", result: { content: [{ type: "text", text: "Converged; reaction balance 0.3%; mesh refinement delta 1.2%." }], details: { outputs: [{ name: "von_mises_view", type: "image", path: "simulation/von-mises.png" }, { name: "fields", type: "field", path: "simulation/stress.vtp", unit: "MPa" }, { name: "max_displacement", type: "scalar", value: 0.34, unit: "mm" }, { name: "max_von_mises", type: "scalar", value: 82, unit: "MPa" }] } } });
      this.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Linear elastic analysis converged and passed reaction-balance and mesh-refinement checks." }], id: "demo-assistant" } });
      this.emit("event", { type: "agent_end" });
      this.status = { ...this.status, state: "ready" }; this.emit("status", this.status);
      return;
    }
    this.emit("event", { type: "tool_execution_start", toolCallId: "demo-build", toolName: "ipython", args: { code: "artifact = await cad.model.build('part.py', 'part.step')" } });
    await wait(120);
    if (generation !== this.generation) return;
    this.emit("event", {
      type: "tool_execution_end", toolCallId: "demo-build", toolName: "ipython",
      result: { content: [{ type: "text", text: "ArtifactRef(role='candidate', path='build/part.step')" }], details: { attachments: [{ mimeType: "image/png", role: "isometric", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] } },
    });
    this.emit("event", { type: "tool_execution_start", toolCallId: "demo-workflow", toolName: "ipython", args: { code: "await cad.workflow.advance('built')" } });
    this.emit("event", { type: "tool_execution_end", toolCallId: "demo-workflow", result: { content: [{ type: "text", text: "Commit(id='commit-dd03e58b622007c794189ba3c99ac2', name='review-candidate', phase='parts', variables=8, artifacts=2) final_review" }] } });
    for (const delta of ["The first model ", "is built and ready ", "for inspection."]) this.emit("event", { type: "message_update", message: { role: "assistant", id: "demo-assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
    this.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The first model is built and ready for inspection." }], id: "demo-assistant" } });
    this.emit("event", { type: "agent_end" });
    this.messages.push({ id: `demo-assistant-${generation}`, role: "assistant", content: "The first model is built and ready for inspection." });
    this.status = { ...this.status, state: "ready" };
    this.emit("status", this.status);
  }
}
