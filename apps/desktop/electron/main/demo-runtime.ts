import { EventEmitter } from "node:events";
import type { AppSettings, ModelChoice, RuntimeStatus, ThinkingLevel } from "../../src/shared/contracts.js";
import { PrimeRuntimeState } from "./runtime-state.js";

const wait = (ms: number) => new Promise((accept) => setTimeout(accept, ms));

/**
 * Deterministic runtime used by the desktop E2E suite. It drives the same
 * runtime state machine as `PrimeRpc`, so statuses shown in tests (retrying,
 * stopping, aborted, terminal reasons) match the real runtime.
 */
export class DemoRuntime extends EventEmitter {
  private readonly runtime = new PrimeRuntimeState({ state: "idle", checks: [] });
  private generation = 0;
  private messages: unknown[] = [];
  private failureTimer?: NodeJS.Timeout;
  private failureDeadline?: number;

  get status(): RuntimeStatus { return this.runtime.status; }

  async start(_settings: AppSettings) {
    this.runtime.base({ state: "starting", checks: [], message: "Starting Prime…" });
    this.publish();
    await wait(120);
    this.runtime.sessionReady("desktop-e2e");
    this.publish();
    return this.status;
  }
  async stop() {
    this.runtime.base({ state: "idle", checks: [] });
    this.publish();
  }
  async abort() {
    this.generation += 1;
    this.runtime.beginStopping();
    this.publish();
    await wait(60);
    this.event({ type: "agent_abort" });
  }
  async steer(message: string) {
    this.runtime.beginTurn("steer");
    this.event({ type: "message_start", message: { role: "user", content: message } });
  }
  async newSession() { this.messages = []; return []; }
  async setSessionName(_name: string) {}
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
    this.runtime.beginTurn("prompt");
    this.event({ type: "message_start", message: { role: "user", content: message, id: "demo-user" } });
    this.event({ type: "agent_start" });
    this.event({ type: "message_update", message: { role: "assistant", id: "demo-assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking requirements" } });
    await wait(80);
    if (generation !== this.generation) return;
    if (/provider retry/i.test(message)) {
      this.event({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded_error: Overloaded", id: "demo-retry" } });
      this.event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1_200, errorMessage: "529 overloaded_error: Overloaded" });
      await this.waitForTurn(1_250, generation);
      if (generation !== this.generation) return;
      this.event({ type: "auto_retry_end", success: true, attempt: 1 });
      this.event({ type: "message_update", message: { role: "assistant", id: "demo-retry" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Recovered after one retry." } });
      this.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Recovered after one retry." }], id: "demo-retry", stopReason: "stop" } });
      this.event({ type: "agent_end", messages: [] });
      this.messages.push({ id: `demo-assistant-${generation}`, role: "assistant", content: "Recovered after one retry." });
      return;
    }
    if (/reasoning limit/i.test(message)) {
      // A reasoning limit is not the end of the turn: the runtime holds the
      // phase through the retry grace, so clients can see it as a live state.
      this.event({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Still working" }], stopReason: "error", errorMessage: "Reasoning budget exhausted for this turn", id: "demo-limit" } });
      await this.waitForTurn(900, generation);
      if (generation !== this.generation) return;
      this.event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 600, errorMessage: "Reasoning budget exhausted for this turn" });
      await this.waitForTurn(650, generation);
      if (generation !== this.generation) return;
      this.event({ type: "auto_retry_end", success: true, attempt: 1 });
      this.event({ type: "message_update", message: { role: "assistant", id: "demo-limit" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Recovered from the reasoning limit." } });
      this.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Recovered from the reasoning limit." }], id: "demo-limit", stopReason: "stop" } });
      this.event({ type: "agent_end", messages: [] });
      this.messages.push({ id: `demo-assistant-${generation}`, role: "assistant", content: "Recovered from the reasoning limit." });
      return;
    }
    if (/simulate interruption/i.test(message)) {
      this.event({ type: "agent_abort" });
      this.runtime.base({ state: "error", message: "The demo worker exited unexpectedly." });
      this.publish();
      return;
    }
    if (/long calculation/i.test(message)) {
      this.event({ type: "tool_execution_start", toolCallId: "demo-long", toolName: "ipython", args: { code: "run_long_calculation()" } });
      await this.waitForTurn(5_000, generation);
      if (generation !== this.generation) return;
    }
    if (/generate concept/i.test(message)) {
      this.event({ type: "tool_execution_start", toolCallId: "demo-concept", toolName: "codex_generate_image", args: { prompt: message } });
      await wait(80);
      if (generation !== this.generation) return;
      this.event({ type: "tool_execution_end", toolCallId: "demo-concept", toolName: "codex_generate_image", result: { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", name: "Concept A" }] } });
      this.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Concept direction ready for selection." }], id: "demo-assistant" } });
      this.event({ type: "agent_end" });
      this.messages.push({ id: `demo-assistant-${generation}`, role: "assistant", content: "Concept direction ready for selection." });
      return;
    }
    if (/format response/i.test(message)) {
      this.event({ type: "tool_execution_start", toolCallId: "demo-read", toolName: "read", args: { path: "requirements.md" } });
      await wait(80);
      if (generation !== this.generation) return;
      this.event({ type: "tool_execution_end", toolCallId: "demo-read", result: { content: [{ type: "text", text: "读取完成" }] } });
      const content = "## 设计约束\n\n**重点尺寸**\n\n- 宽度 80 mm\n- 厚度 3 mm\n\n---\n\n| 项目 | 数值 |\n| --- | --- |\n| 倾角 | 65° |";
      this.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: content }], id: "demo-assistant" } });
      this.event({ type: "agent_end" });
      this.messages.push({ id: `demo-assistant-${generation}`, role: "assistant", content });
      return;
    }
    if (/simulation\/torch-fem-linear-elastic/i.test(message)) {
      this.event({ type: "tool_execution_start", toolCallId: "demo-simulation-run", toolName: "ipython", args: { code: "await cad.simulation.run(recipe='simulation/torch-fem-linear-elastic')" } });
      await wait(800);
      if (generation !== this.generation) return;
      this.event({ type: "tool_execution_update", toolCallId: "demo-simulation-run", stage: "Checking reaction balance and convergence", progress: .82 });
      this.event({ type: "tool_execution_end", toolCallId: "demo-simulation-run", result: { content: [{ type: "text", text: "Converged; reaction balance 0.3%; mesh refinement delta 1.2%." }], details: { outputs: [{ name: "von_mises_view", type: "image", path: "simulation/von-mises.png" }, { name: "fields", type: "field", path: "simulation/stress.vtp", unit: "MPa" }, { name: "max_displacement", type: "scalar", value: 0.34, unit: "mm" }, { name: "max_von_mises", type: "scalar", value: 82, unit: "MPa" }] } } });
      this.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Linear elastic analysis converged and passed reaction-balance and mesh-refinement checks." }], id: "demo-assistant" } });
      this.event({ type: "agent_end" });
      return;
    }
    this.event({ type: "tool_execution_start", toolCallId: "demo-build", toolName: "ipython", args: { code: "artifact = await cad.model.build('part.py', 'part.step')" } });
    await wait(120);
    if (generation !== this.generation) return;
    this.event({
      type: "tool_execution_end", toolCallId: "demo-build", toolName: "ipython",
      result: { content: [{ type: "text", text: "ArtifactRef(role='candidate', path='build/part.step')" }], details: { attachments: [{ mimeType: "image/png", role: "isometric", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] } },
    });
    this.event({ type: "tool_execution_start", toolCallId: "demo-workflow", toolName: "ipython", args: { code: "await cad.workflow.advance('built')" } });
    this.event({ type: "tool_execution_end", toolCallId: "demo-workflow", result: { content: [{ type: "text", text: "Commit(id='commit-dd03e58b622007c794189ba3c99ac2', name='review-candidate', phase='parts', variables=8, artifacts=2) final_review" }] } });
    for (const delta of ["The first model ", "is built and ready ", "for inspection."]) this.event({ type: "message_update", message: { role: "assistant", id: "demo-assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
    this.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The first model is built and ready for inspection." }], id: "demo-assistant" } });
    this.event({ type: "agent_end" });
    this.messages.push({ id: `demo-assistant-${generation}`, role: "assistant", content: "The first model is built and ready for inspection." });
  }

  /** Apply a Prime event to both the status machine and the renderer stream. */
  private event(value: unknown) {
    this.runtime.applyEvent(value);
    this.emit("event", value);
    this.syncFailureTimer();
    this.publish();
  }

  /** Same deadline rule as `PrimeRpc`: the grace belongs to the failure itself. */
  private syncFailureTimer() {
    const deadline = this.runtime.failureDeadline;
    if (deadline === this.failureDeadline) return;
    if (this.failureTimer) clearTimeout(this.failureTimer);
    this.failureTimer = undefined;
    this.failureDeadline = deadline;
    if (deadline === undefined) return;
    this.failureTimer = setTimeout(() => {
      this.failureTimer = undefined;
      this.failureDeadline = undefined;
      this.runtime.settleFailure();
      this.publish();
    }, Math.max(0, deadline - Date.now()));
    this.failureTimer.unref?.();
  }

  private publish() {
    this.emit("status", this.runtime.status);
  }

  /** Long demo work stops as soon as the turn is aborted. */
  private async waitForTurn(ms: number, generation: number) {
    const step = 25;
    for (let elapsed = 0; elapsed < ms && generation === this.generation; elapsed += step) {
      await wait(Math.min(step, ms - elapsed));
    }
  }
}
