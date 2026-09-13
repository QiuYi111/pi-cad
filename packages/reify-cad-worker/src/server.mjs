import { createInterface } from "node:readline";
import { WorkerError } from "./errors.mjs";
import { WorkerCore } from "./session.mjs";

const PROTOCOL_VERSION = "2025-06-18";

const TOOL_DEFINITIONS = [
  tool("cad_worker.start", "Start a persistent Reify/Pi-CAD worker session.", {
    type: "object", required: ["cwd"], additionalProperties: false,
    properties: {
      cwd: { type: "string", description: "Linux/WSL project directory" },
      workflow: { type: "string", description: "Optional Pi-CAD workflow ID" },
      prompt: { type: "string", description: "Engineering objective" },
      permission: { type: "string", enum: ["read-only", "workspace"] },
      callerHost: { type: "string", enum: ["windows", "wsl"] },
      model: { type: "object", additionalProperties: false, properties: { provider: { type: "string" }, model: { type: "string" }, thinking: { type: "string" } } },
    },
  }),
  tool("cad_worker.send", "Send a task or follow-up to the same persistent session.", {
    type: "object", required: ["session_id", "prompt"], additionalProperties: false,
    properties: { session_id: { type: "string" }, prompt: { type: "string" } },
  }),
  tool("cad_worker.status", "Get compact live status and progress indicators.", {
    type: "object", required: ["session_id"], additionalProperties: false, properties: { session_id: { type: "string" } },
  }),
  tool("cad_worker.events", "Read a bounded incremental activity feed.", {
    type: "object", required: ["session_id"], additionalProperties: false,
    properties: { session_id: { type: "string" }, after: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } },
  }),
  tool("cad_worker.artifacts", "List STEP, source, render and evidence handles.", {
    type: "object", required: ["session_id"], additionalProperties: false, properties: { session_id: { type: "string" } },
  }),
  tool("cad_worker.steer", "Inject a correction into the running Prime turn without starting a session.", {
    type: "object", required: ["session_id", "instruction"], additionalProperties: false,
    properties: { session_id: { type: "string" }, instruction: { type: "string" } },
  }),
  tool("cad_worker.interrupt", "Interrupt the current action and preserve the session.", {
    type: "object", required: ["session_id"], additionalProperties: false, properties: { session_id: { type: "string" } },
  }),
  tool("cad_worker.cancel", "Cancel the current task.", {
    type: "object", required: ["session_id"], additionalProperties: false,
    properties: { session_id: { type: "string" }, reason: { type: "string" } },
  }),
  tool("cad_worker.request_checkpoint", "Ask Prime to summarize state before continuing.", {
    type: "object", required: ["session_id"], additionalProperties: false, properties: { session_id: { type: "string" } },
  }),
  tool("cad_worker.close", "Stop the process and remove the session.", {
    type: "object", required: ["session_id"], additionalProperties: false, properties: { session_id: { type: "string" } },
  }),
];

export async function dispatchTool(core, name, args = {}) {
  switch (name) {
    case "cad_worker.start": return core.start(args);
    case "cad_worker.send": return core.send(args);
    case "cad_worker.status": return core.status(args);
    case "cad_worker.events": return core.events(args);
    case "cad_worker.artifacts": return core.artifacts(args);
    case "cad_worker.steer": return core.steer(args);
    case "cad_worker.interrupt": return core.interrupt(args);
    case "cad_worker.cancel": return core.cancel(args);
    case "cad_worker.request_checkpoint": return core.requestCheckpoint(args);
    case "cad_worker.close": return core.close(args);
    default: throw new WorkerError(`unknown tool: ${name}`, "unknown_tool");
  }
}

export function toolCatalog() {
  return { tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
}

export async function serveMcp(input = process.stdin, output = process.stdout, core = new WorkerCore()) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch {
      write(output, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    try { write(output, await handleMessage(core, request)); }
    catch (error) {
      write(output, {
        jsonrpc: "2.0", id: request?.id ?? null,
        error: { code: error instanceof WorkerError && error.code === "invalid_session" ? -32002 : -32000, message: error.message, data: { code: error.code || "worker_error" } },
      });
    }
  }
  await core.closeAll();
}

async function handleMessage(core, request) {
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  if (request.method === "initialize") {
    return result(request, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "reify-cad-worker", title: "Reify CAD Worker", version: "0.1.0" },
    });
  }
  if (request.method === "notifications/initialized") return undefined;
  if (request.method === "ping") return result(request, {});
  if (request.method === "tools/list") return result(request, toolCatalog());
  if (request.method === "tools/call") {
    try {
      const value = await dispatchTool(core, request.params?.name, request.params?.arguments || {});
      return result(request, {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
        isError: false,
      });
    } catch (error) {
      return result(request, {
        content: [{ type: "text", text: `${error.code || "worker_error"}: ${error.message}` }],
        isError: true,
      });
    }
  }
  return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: "Method not found" } };
}

function result(request, value) {
  if (request.id === undefined || request.id === null) return undefined;
  return { jsonrpc: "2.0", id: request.id, result: value };
}
function write(output, value) { if (value) output.write(`${JSON.stringify(value)}\n`); }

function tool(name, description, inputSchema) { return { name, description, inputSchema }; }
