import { EventEmitter } from "node:events";

export class FakePrime extends EventEmitter {
  #sequence = 0;
  #pending = new Map();
  constructor(options = {}) {
    super();
    this.options = options;
    this.sessionId = options.sessionId || "prime-session";
    this.turn = 0;
    this.steerCount = 0;
    this.abortCount = 0;
    this.promptCount = 0;
    this.getMessagesCount = 0;
    this.stopped = false;
    this.state = options.initialState || "ready";
    this.workflowStatus = options.workflowStatus || "no_workflow";
    this.promptResolve;
  }
  running() { return !this.stopped; }
  on(event, handler) { return super.on(event, handler); }
  request(type, payload = {}) {
    if (type === "get_state") return Promise.resolve({ state: this.state, sessionId: this.sessionId });
    if (type === "prompt") {
      this.promptCount += 1;
      this.turn += 1;
      this.state = "streaming";
      const turn = this.turn;
      this.emit("event", { type: "agent_start" });
      this.emit("event", { type: "tool_execution_start", toolCallId: `${turn}-1`, toolName: "ipython", args: { code: this.options.failingCode || "cad.probe.run()" } });
      let failures = this.options.failures ?? 0;
      const emitFailure = () => {
        if (failures-- > 0) {
          this.emit("event", { type: "tool_execution_end", toolCallId: `${turn}-1`, toolName: "ipython", state: "error", args: { code: this.options.failingCode || "cad.probe.run()" } });
          setTimeout(emitFailure, 1);
          return;
        }
        this.emit("event", { type: "tool_execution_end", toolCallId: `${turn}-1`, toolName: "ipython", state: "success", args: { code: this.options.failingCode || "cad.probe.run()" } });
        this.state = "ready";
        this.emit("event", { type: "agent_end" });
      };
      setTimeout(emitFailure, this.options.promptDelayMs ?? 1);
      return Promise.resolve();
    }
    if (type === "steer") {
      this.steerCount += 1;
      if (this.state === "streaming" && this.options.onSteer) this.options.onSteer();
      return Promise.resolve();
    }
    if (type === "abort") {
      this.abortCount += 1;
      this.state = "ready";
      return Promise.resolve();
    }
    if (type === "get_messages") { this.getMessagesCount += 1; return Promise.resolve({ messages: [] }); }
    return Promise.reject(new Error(`unexpected request ${type}`));
  }
  async steer() { await this.request("steer"); }
  async abort() { await this.request("abort"); }
  async stop() { this.stopped = true; }
}

export function fakeLauncherFactory(options = {}) {
  const primes = [];
  return {
    primes,
    launcher(session, config, input) {
      const prime = new FakePrime({ sessionId: `prime-${session.id}`, workflowStatus: options.workflowStatus, ...options });
      primes.push(prime);
      return prime;
    },
  };
}
