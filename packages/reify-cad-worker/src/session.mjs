import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat as statFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { WorkerError, staleSession } from "./errors.mjs";
import { PrimeRpc } from "./prime-rpc.mjs";
import { normalizeProjectRoot, runtimePaths, runtimeConfiguration } from "./runtime.mjs";


export class WorkerCore {
  #sessions = new Map();
  #now;
  #agentApi;
  constructor(options = {}) {
    this.launcher = options.launcher || defaultLauncher;
    this.idFactory = options.idFactory || (() => `cad-${crypto.randomUUID()}`);
    this.#now = options.now || Date.now;
    this.#agentApi = options.agentApi || agentApi;
  }

  async start(input = {}) {
    const cwd = normalizeProjectRoot(input.cwd);
    const config = runtimeConfiguration(input);
    const cwdStat = await statFile(cwd).catch(() => null);
    if (!cwdStat?.isDirectory()) throw new WorkerError(`project cwd does not exist or is not a directory: ${cwd}`, "invalid_argument");
    const session = {
      id: this.idFactory(),
      cwd,
      startedAt: this.#now(),
      lastProgressAt: this.#now(),
      callerHost: config.callerHost,
      wslDistro: config.wslDistro,
      model: config.model,
      prime: null,
      workflow: null,
      workflowStatus: "unknown",
      blocker: null,
      currentTaskId: null,
      canceled: false,
      runtimeState: "starting",
      needsInput: false,
      userInputSummary: null,
      lastAssistantSummary: null,
      modelErrors: 0,
      modelFailureStreak: 0,
      lastModelError: null,
      taskStarted: false,
      events: [],
      eventCursor: 0,
      operationCounts: new Map(),
      failureStreak: 0,
      lastFailureSignature: "",
      agentTurns: 0,
      toolErrors: 0,
      toolCalls: 0,
      transcriptReads: 0,
      closed: false,
    };
    const prime = await this.launcher(session, config, input);
    session.prime = prime;
    prime.on("event", (record) => this.#recordPrimeEvent(session, record));
    prime.on("diagnostic", (message) => this.#event(session, "diagnostic", message.slice(-300)));
    prime.on("exit", ({ code, signal }) => {
      session.closed = true;
      this.#event(session, "prime_exit", `Prime exited with ${signal || code || 0}`);
    });
    this.#sessions.set(session.id, session);
    try {
      await prime.request("get_state", {}, 45_000);
      session.runtimeState = "ready";
    } catch (error) {
      this.#sessions.delete(session.id);
      await prime.stop().catch(() => {});
      throw error;
    }
    this.#event(session, "session_started", `Prime session ready in ${cwd}`);
    if (typeof input.prompt === "string" && input.prompt.trim()) return this.send({ session_id: session.id, prompt: composePrompt(input) });
    return this.status({ session_id: session.id });
  }

  #get(id) {
    const session = this.#sessions.get(id);
    if (!session || session.closed) throw staleSession(id);
    return session;
  }

  async send(input = {}) {
    const session = this.#get(input.session_id);
    const prompt = requiredText(input.prompt, "prompt");
    const state = await session.prime.request("get_state", {}, 10_000);
    const busy = state?.state === "streaming" || state?.state === "starting" || session.runtimeState === "running" || (session.currentTaskId && !session.taskStarted);
    if (busy) {
      throw new WorkerError("CAD worker is busy; use cad_worker.steer to correct the current turn", "worker_busy");
    }
    const taskId = `task-${crypto.randomUUID()}`;
    session.currentTaskId = taskId;
    session.canceled = false;
    session.needsInput = false;
    session.userInputSummary = null;
    session.modelFailureStreak = 0;
    session.lastModelError = null;
    session.taskStarted = false;
    session.runtimeState = "starting";
    session.lastProgressAt = this.#now();
    this.#event(session, "task_accepted", concise(prompt), { taskId });
    session.prime.request("prompt", { message: prompt }, 10_000)
      .catch((error) => {
        if (/already processing|suspended/i.test(error.message)) return session.prime.steer(prompt);
        throw error;
      })
      .then(() => this.#event(session, "task_started", "Prime accepted the turn", { taskId }))
      .catch((error) => {
        if (session.currentTaskId === taskId) session.currentTaskId = null;
        session.runtimeState = "error";
        this.#event(session, "task_failed", error.message, { taskId });
      });
    return this.status({ session_id: session.id });
  }

  async steer(input = {}) {
    const session = this.#get(input.session_id);
    const instruction = requiredText(input.instruction, "instruction");
    const state = await session.prime.request("get_state", {}, 10_000);
    const busy = state?.state === "streaming" || state?.state === "starting" || session.runtimeState === "running";
    if (!busy) {
      return this.send({ session_id: session.id, prompt: instruction });
    }
    await session.prime.steer(instruction);
    session.lastProgressAt = this.#now();
    this.#event(session, "steered", concise(instruction));
    return this.status({ session_id: session.id });
  }

  async interrupt(input = {}) {
    const session = this.#get(input.session_id);
    await session.prime.abort();
    this.#event(session, "interrupted", "Current Prime action interrupted; session retained");
    session.lastProgressAt = this.#now();
    return this.status({ session_id: session.id });
  }

  async cancel(input = {}) {
    const session = this.#get(input.session_id);
    await session.prime.abort();
    session.canceled = true;
    if (session.currentTaskId) this.#event(session, "task_canceled", requiredText(input.reason || "canceled", "reason"), { taskId: session.currentTaskId });
    session.currentTaskId = null;
    return this.status({ session_id: session.id });
  }

  async requestCheckpoint(input = {}) {
    const session = this.#get(input.session_id);
    return this.send({
      session_id: session.id,
      prompt: "Do no new CAD work. Summarize the current hypothesis, evidence, failure mode, and next step in at most 120 words, then wait.",
    });
  }

  async status(input = {}) {
    const session = this.#get(input.session_id);
    const primeState = await session.prime.request("get_state", {}, 10_000).catch(() => ({ state: "unavailable" }));
    await this.#syncWorkflow(session);
    const value = compactStatus(session, primeState, this.#now());
    value.transcript_log = await transcriptLog(session);
    return value;
  }

  async events(input = {}) {
    const session = this.#get(input.session_id);
    const after = Number.isInteger(input.after) ? Math.max(0, input.after) : Math.max(0, session.eventCursor - 20);
    const events = session.events.filter((event) => event.seq > after).slice(-Math.min(Number(input.limit) || 20, 100));
    return { session_id: session.id, cursor: session.eventCursor, events };
  }

  async artifacts(input = {}) {
    const session = this.#get(input.session_id);
    const [scanned, catalog] = await Promise.all([
      projectArtifactScan(session.cwd),
      this.#agentApi(session.cwd, { schema: 1, op: "viewer-catalog" }).catch((error) => {
        this.#event(session, "artifact_catalog_unavailable", concise(error.message));
        return null;
      }),
    ]);
    const artifacts = [];
    const seen = new Set();
    const push = (path, role, sha256) => {
      if (typeof path !== "string" || seen.has(`${path}\0${sha256 || ""}`)) return;
      const kind = artifactKind(path, role);
      if (!kind) return;
      seen.add(`${path}\0${sha256 || ""}`);
      const absolute = resolve(session.cwd, path);
      if (!absolute.startsWith(`${session.cwd}${sep}`)) return;
      artifacts.push({ path: absolute, project_path: path, role: role || kind, kind, ...(sha256 ? { sha256 } : {}), ...pathForms(session, absolute) });
    };
    for (const artifact of catalog?.projectHead?.artifacts || []) push(artifact.path, artifact.role, artifact.sha256);
    for (const artifact of catalog?.currentRun?.artifacts || []) push(artifact.path, artifact.role, artifact.sha256);
    for (const artifact of scanned) push(artifact.path, artifact.role, artifact.sha256);
    return { session_id: session.id, artifacts: artifacts.slice(-100), count: artifacts.length };
  }

  async close(input = {}) {
    const session = this.#sessions.get(input.session_id);
    if (!session) throw staleSession(input.session_id);
    session.closed = true;
    await session.prime.stop().catch(() => {});
    this.#sessions.delete(session.id);
    this.#event(session, "session_closed", "Prime process stopped and session removed");
    return { session_id: session.id, closed: true };
  }

  async closeAll() {
    for (const id of [...this.#sessions.keys()]) await this.close({ session_id: id }).catch(() => {});
  }

  async #syncWorkflow(session) {
    if (session.workflowSyncRunning) return;
    session.workflowSyncRunning = true;
    try {
      const projectionPath = join(session.cwd, ".pi-cad", "status.json");
      const raw = await readFile(projectionPath, "utf8").catch(() => "");
      const current = raw ? JSON.parse(raw).run : null;
      if (current) {
        session.workflow = {
          id: current.workflowId,
          version: current.workflowVersion,
          hash: current.workflowHash,
          phase: current.phase,
          purpose: current.purpose,
          runId: current.runId,
        };
        session.workflowStatus = current.status || "unknown";
        const blocker = (current.warnings || []).find((item) => /blocked_external|USER_DECISION|waiting_user|wait_for_user|clarification/i.test(item));
        session.blocker = blocker ? { type: /waiting_user|wait_for_user|clarification|USER_DECISION/i.test(blocker) ? "USER_DECISION_REQUIRED" : "BLOCKED", message: blocker } : null;
      } else {
        session.workflow = null;
        session.workflowStatus = "no_workflow";
        session.blocker = null;
      }
    } catch (error) {
      this.#event(session, "workflow_sync_failed", concise(error.message));
    } finally {
      session.workflowSyncRunning = false;
    }
  }

  #recordPrimeEvent(session, record) {
    const inner = record.type === "session_event" ? record.event : record;
    if (!inner || typeof inner !== "object") return;
    const at = this.#now();
    if (inner.type === "agent_start") {
      session.agentTurns += 1;
      session.taskStarted = true;
      session.runtimeState = "running";
      session.lastProgressAt = at;
      this.#event(session, "agent_started", "Prime turn started");
      return;
    }
    if (inner.type === "agent_status") {
      const taskState = inner.status?.taskState;
      if (taskState === "needs_input") {
        session.runtimeState = "waiting_user";
        if (!session.needsInput) {
          session.needsInput = true;
          session.userInputSummary = session.lastAssistantSummary || "Prime needs a user decision";
          this.#event(session, "user_input_required", session.userInputSummary);
        }
      }
      return;
    }
    if (inner.type === "agent_end") {
      session.runtimeState = "ready";
      this.#event(session, "agent_finished", "Prime turn finished");
      return;
    }
    if (inner.type === "message_end" && inner.message?.role === "assistant") {
      const message = inner.message;
      if (message.stopReason === "error") {
        session.modelErrors += 1;
        session.modelFailureStreak += 1;
        session.lastModelError = concise(message.errorMessage || "Prime model call failed");
        this.#event(session, "model_failed", session.lastModelError, { failure_streak: session.modelFailureStreak });
      } else if (message.stopReason !== "aborted") {
        session.modelFailureStreak = 0;
        session.lastModelError = null;
        const text = Array.isArray(message.content) ? message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ") : "";
        if (text.trim()) {
          session.lastAssistantSummary = concise(text);
          session.lastProgressAt = at;
        }
      }
      return;
    }
    if (inner.type === "tool_execution_start") {
      session.toolCalls += 1;
      const category = operationCategory(inner.toolName, inner.args || inner.input);
      session.operationCounts.set(category, (session.operationCounts.get(category) || 0) + 1);
      session.lastProgressAt = at;
      this.#event(session, "action_started", category, { category, tool: inner.toolName });
      return;
    }
    if (inner.type === "tool_execution_end") {
      const category = operationCategory(inner.toolName, inner.args || inner.input);
      const failed = inner.state === "error" || inner.isError === true || inner.success === false;
      if (failed) {
        session.toolErrors += 1;
        session.failureStreak = category === session.lastFailureSignature ? session.failureStreak + 1 : 1;
        session.lastFailureSignature = category;
      } else {
        session.failureStreak = 0;
        session.lastFailureSignature = "";
        session.lastProgressAt = at;
      }
      this.#event(session, failed ? "action_failed" : "action_finished", category, { category, tool: inner.toolName, failure_streak: session.failureStreak });
    }
  }

  #event(session, type, summary, extra = {}) {
    session.eventCursor += 1;
    session.events.push({ seq: session.eventCursor, at: new Date(this.#now()).toISOString(), type, summary: String(summary || "").slice(0, 240), ...extra });
    if (session.events.length > 240) session.events.splice(0, session.events.length - 240);
  }
}

function composePrompt({ workflow, prompt }) {
  const objective = prompt.trim();
  return workflow
    ? `Run the Pi-CAD workflow \`${workflow}\` for this engineering objective:\n\n${objective}\n\nUse the existing Pi-CAD workflow, tools, evidence and review semantics. Surface a material user decision instead of guessing.`
    : objective;
}

function compactStatus(session, primeState, now = Date.now()) {
  const rawState = primeState?.state && primeState.state !== "unknown" ? primeState.state : session.runtimeState;
  const modelBlocked = session.modelFailureStreak >= 3;
  const state = session.canceled ? "canceled" : session.needsInput || session.workflowStatus === "waiting_user" ? "waiting_user" : modelBlocked ? "blocked" : session.currentTaskId && !session.taskStarted ? "starting" : rawState === "streaming" || rawState === "starting" ? "running" : rawState === "error" ? "error" : session.workflowStatus === "blocked_external" ? "blocked" : rawState || "unknown";
  const blocker = state === "waiting_user" ? session.blocker || { type: "USER_DECISION_REQUIRED", message: session.userInputSummary || "Prime needs a user decision" } : modelBlocked ? { type: "MODEL_FAILURE", message: session.lastModelError || "Prime model calls repeatedly failed" } : session.blocker;
  const outcome = session.workflowStatus === "done" && state !== "running" && state !== "starting" ? "done" : state === "waiting_user" ? "USER_DECISION_REQUIRED" : state === "blocked" ? "BLOCKED" : undefined;
  const idleActiveWorkflow = session.workflow && !["done", "completed", "terminal"].includes(session.workflowStatus) && state === "ready";
  const stalled = (state === "starting" || idleActiveWorkflow) && now - session.lastProgressAt > 90_000;
  return {
    session_id: session.id,
    task_id: session.currentTaskId,
    status: state,
    ...(outcome ? { outcome } : {}),
    prime_session_id: primeState?.sessionId,
    cwd: session.cwd,
    ...pathForms(session, session.cwd),
    model: session.model,
    workflow: session.workflow,
    last_action: [...session.events].reverse().find((event) => event.type.startsWith("action_"))?.summary || null,
    recent_events: session.events.slice(-5),
    elapsed_ms: Math.max(0, now - session.startedAt),
    ms_since_progress: Math.max(0, now - session.lastProgressAt),
    transcript_log: null,
    metrics: {
      agent_turns: session.agentTurns,
      tool_calls: session.toolCalls,
      tool_errors: session.toolErrors,
      model_errors: session.modelErrors,
      repeated_failure_streak: session.failureStreak,
      transcript_bytes_returned: 0,
    },
    progress_signal: modelBlocked ? "model_failure" : session.failureStreak >= 3 ? "repeated_failure" : stalled ? "stalled" : state === "ready" ? "idle" : "progressing",
    blocker,
    ...(outcome === "done" ? { summary: "Pi-CAD reports the workflow complete; inspect returned artifacts and evidence." } : {}),
  };
}

async function transcriptLog(session) {
  try {
    const directory = join(session.cwd, ".prime-sessions");
    const names = (await readdir(directory)).filter((name) => /^[A-Za-z0-9._-]+\.jsonl$/.test(name));
    let newest;
    for (const name of names) {
      const path = join(directory, name);
      const info = await statFile(path);
      if (!info.isFile()) continue;
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs };
    }
    return newest ? { path: newest.path, ...pathForms(session, newest.path) } : null;
  } catch { return null; }
}

function pathForms(session, path) {
  return { paths: runtimePaths(path, session.callerHost, session.wslDistro) };
}

async function projectArtifactScan(root) {
  const roots = ["session-artifacts", "build", "renders", "evidence", ".pi-cad/runs"];
  const found = [];
  const scan = async (directory, depth) => {
    if (depth > 8 || found.length >= 500) return;
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= 500 || entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await scan(path, depth + 1);
      else if (entry.isFile()) {
        const kind = artifactKind(path);
        if (!kind) continue;
        const info = await statFile(join(root, path));
        found.push({ path, role: kind, sha256: undefined, bytes: info.size });
      }
    }
  };
  for (const directory of roots) await scan(directory, 0);
  return found;
}

function artifactKind(path, role) {
  if (/\.(step|stp)$/i.test(path) || role === "candidate:authoritative") return "step";
  if (/\.(py|ipython)$/i.test(path) || role === "candidate:source") return "source";
  if (/\.(png|jpe?g|webp)$/i.test(path)) return "render";
  if (/evidence|verification|review/i.test(`${path} ${role}`)) return "evidence";
  return null;
}

async function agentApi(cwd, op) {
  const root = await realpath(cwd);
  const canonical = join(process.env.XDG_DATA_HOME?.startsWith("/") ? process.env.XDG_DATA_HOME : resolve(process.env.HOME || "/", "home-placeholder", ".local/share"), "pi-cad", createHash("sha256").update(root).digest("hex"));
  const child = spawn(process.execPath, [join(REPO_ROOT(), "scripts", "pi-cad-agent-api.mjs"), "agent-api", root], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_CAD_REPO: REPO_ROOT(), PI_CAD_PROJECT_CWD: root, PI_CAD_CANONICAL_PROJECT_DIR: canonical },
  });
  child.stdin.end(JSON.stringify(op));
  const stdout = await new Promise((accept, reject) => {
    let data = "";
    let error = "";
    const timer = setTimeout(() => { child.kill(); reject(new WorkerError("Pi-CAD catalog timed out", "agent_api_failed")); }, 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      data += chunk;
      if (data.length > 8 * 1024 * 1024) { child.kill(); reject(new WorkerError("Pi-CAD catalog result is too large", "agent_api_failed")); }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { error = (error + chunk).slice(-500); });
    child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) accept(data);
      else reject(new WorkerError(`Pi-CAD catalog failed: ${error || code}`, "agent_api_failed"));
    });
  });
  const response = JSON.parse(stdout);
  if (!response.ok) throw new WorkerError(response.error?.message || "Pi-CAD Agent API failed", "agent_api_failed");
  return response.result;
}

import { dirname as _dirname } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
function REPO_ROOT() { return resolve(_dirname(_fileURLToPath(import.meta.url)), "../../.."); }

function operationCategory(toolName = "", input = {}) {
  const code = String(input.code || input.command || input.path || "");
  if (/cad\.(?:model\.build|save_and_check)/.test(code)) return "build";
  if (/cad\.probe\.run/.test(code)) return "probe";
  if (/cad\.simulation\.run/.test(code)) return "simulation";
  if (/cad\.review/.test(code)) return "review";
  if (/cad\.commit/.test(code)) return "commit";
  if (/cad\.workflow/.test(code)) return "workflow";
  return String(toolName || "tool").replace(/^.*[.:/]/, "").replace(/_/g, " ");
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new WorkerError(`${field} must be a non-empty string`, "invalid_argument");
  return value.trim();
}
function concise(value) { return value.replace(/\s+/g, " ").trim().slice(0, 240); }

async function defaultLauncher(session, config, input) {
  const args = [
    join(config.piCadRepo, "scripts", "prime-cad-sidecar.mjs"),
    "--mode", "rpc",
    "--provider", config.model.provider,
    "--model", config.model.model,
    "--thinking", config.model.thinking,
    "--reviewer-inherit-author",
  ];
  const prime = new PrimeRpc(config.nodePath, args, {
    PI_CAD_REPO: config.piCadRepo,
    PI_CAD_PROJECT_CWD: session.cwd,
    PRIME_AGENT_REPO: config.primeAgentRepo,
    PRIME_AGENT_CODING_AGENT_DIR: config.primeAgentDir,
    PI_CAD_NODE_WRAPPER: config.nodePath,
    PI_CAD_DESKTOP_PERMISSION: config.permission,
  });
  prime.start();
  return prime;
}
