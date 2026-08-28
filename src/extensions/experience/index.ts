import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  completeDistillation,
  findExperience,
  getExperience,
  maybeBeginDistillation,
  readExperience,
  recordEvaluation,
  runConfiguredDistillation,
  searchExperience,
} from "../../experience/store.ts";

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
}

function failed(error: unknown): AgentToolResult {
  return { content: [{ type: "text", text: `Experience operation failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
}

const identifier = {
  seq: Type.Optional(Type.Integer({ minimum: 1 })),
  sha: Type.Optional(Type.String({ minLength: 8 })),
};

function idOf(params: { seq?: number; sha?: string }): { seq?: number; sha?: string } {
  if (params.seq === undefined && !params.sha) throw new Error("seq or sha is required");
  return params.seq !== undefined ? { seq: params.seq } : { sha: params.sha };
}

export default function experienceExtension(pi: ExtensionAPI) {
  pi.events.on("pi-cad:distillation-requested", (payload) => {
    const requestPath = (payload as { request_path?: unknown })?.request_path;
    if (typeof requestPath !== "string") return;
    void runConfiguredDistillation(requestPath).catch((error) => {
      pi.events.emit("pi-cad:distillation-failed", {
        request_path: requestPath,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  pi.registerTool({
    name: "cad_experience_search",
    label: "Search CAD Experience",
    description: "Search archived CAD trajectories by keywords, metadata, evaluation, cost, and rank.",
    promptSnippet: "Find relevant prior CAD trajectories before repeating costly work",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      workflow: Type.Optional(Type.String()),
      project_name: Type.Optional(Type.String()),
      project_path: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      reasoning: Type.Optional(Type.String()),
      min_quality: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      max_quality: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      min_difficulty: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      max_difficulty: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
      max_score: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
      timestamp_from: Type.Optional(Type.String()),
      timestamp_to: Type.Optional(Type.String()),
      min_transcript_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
      max_transcript_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
      min_processed_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
      max_processed_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
      min_duration_s: Type.Optional(Type.Number({ minimum: 0 })),
      max_duration_s: Type.Optional(Type.Number({ minimum: 0 })),
      evaluation_status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("evaluated")])),
      sort: Type.Optional(Type.Union(["relevance", "score", "quality", "difficulty", "timestamp", "duration", "transcript_tokens", "processed_tokens"].map((value) => Type.Literal(value)))),
      order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try { return ok(await searchExperience(params)); } catch (error) { return failed(error); }
    },
  });

  pi.registerTool({
    name: "cad_experience_get",
    label: "Get CAD Experience",
    description: "Get metadata, evaluation, metrics pointers, and archive location for one trajectory.",
    promptSnippet: "Inspect one archived CAD trajectory's metadata",
    parameters: Type.Object(identifier, { additionalProperties: false }),
    async execute(_id, params) {
      try { return ok(await getExperience(idOf(params))); } catch (error) { return failed(error); }
    },
  });

  pi.registerTool({
    name: "cad_experience_read",
    label: "Read CAD Experience",
    description: "Read a bounded line range from an archived readable transcript (default: lines 1-400).",
    promptSnippet: "Read a bounded portion of a prior CAD trajectory",
    parameters: Type.Object({ ...identifier, start_line: Type.Optional(Type.Integer({ minimum: 1 })), end_line: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
    async execute(_id, params) {
      try { return ok(await readExperience(idOf(params), params.start_line, params.end_line)); } catch (error) { return failed(error); }
    },
  });

  pi.registerTool({
    name: "cad_experience_find",
    label: "Find in CAD Experience",
    description: "Find keyword matches and bounded surrounding line ranges in one archived transcript.",
    promptSnippet: "Locate relevant passages inside a prior CAD trajectory",
    parameters: Type.Object({ ...identifier, query: Type.String({ minLength: 1 }), context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    async execute(_id, params) {
      try { return ok(await findExperience(idOf(params), params.query, params.context, params.limit)); } catch (error) { return failed(error); }
    },
  });

  pi.registerCommand("cad-rate", {
    description: "Rate an archived run: /cad-rate <seq> <quality 1-5> <difficulty 1-5>",
    handler: async (args, ctx) => {
      const [seq, quality, difficulty] = args.trim().split(/\s+/).map(Number);
      try {
        const entry = await recordEvaluation({ seq }, quality, difficulty);
        const trigger = await maybeBeginDistillation();
        if (trigger.triggered) pi.events.emit("pi-cad:distillation-requested", trigger);
        if (ctx.hasUI) ctx.ui.notify(`Run ${entry.seq} rated; score=${entry.score}${trigger.triggered ? `; distillation cutoff=${trigger.cutoff_seq}` : ""}`, "info");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("cad-distill-complete", {
    description: "Record an external skill-distillation result: /cad-distill-complete success|failed",
    handler: async (args, ctx) => {
      try {
        const value = args.trim().toLocaleLowerCase();
        if (value !== "success" && value !== "failed") throw new Error("usage: /cad-distill-complete success|failed");
        const state = await completeDistillation(value === "success");
        if (ctx.hasUI) ctx.ui.notify(`Distillation ${value}; cursor=${state.last_distilled_seq}; pending=${state.pending_transcript_tokens}`, value === "success" ? "info" : "warning");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
