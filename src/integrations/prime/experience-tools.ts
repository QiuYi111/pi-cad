import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { requestAuthority } from "./sidecar-client.ts";

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

/** Prime-native, sidecar-owned bounded access to prior CAD trajectories. */
export function registerExperienceTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "cad_experience_search",
    label: "Search CAD Experience",
    description: "Search prior CAD trajectories in the current isolated experience library by keywords, metadata, human evaluation, or benchmark evaluation.",
    promptSnippet: "You can look at prior CAD trajectories to learn how others approached similar work; comparing high- and low-scoring examples may be useful",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      workflow: Type.Optional(Type.String()),
      project_name: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      reasoning: Type.Optional(Type.String()),
      min_quality: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
      benchmark: Type.Optional(Type.String()),
      partition: Type.Optional(Type.String()),
      sample_id: Type.Optional(Type.String()),
      min_benchmark_score: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
      benchmark_exact_pass: Type.Optional(Type.Boolean()),
      evaluation_status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("evaluated")])),
      sort: Type.Optional(Type.Union(["relevance", "score", "benchmark_score", "quality", "difficulty", "timestamp", "duration", "transcript_tokens", "processed_tokens"].map((value) => Type.Literal(value)))),
      order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try { return ok(await requestAuthority({ op: "experience-search", options: params })); }
      catch (error) { return failed(error); }
    },
  });

  pi.registerTool({
    name: "cad_experience_get",
    label: "Get CAD Experience",
    description: "Get safe identity, metrics, human evaluation, and benchmark evaluation for one prior trajectory without host filesystem paths.",
    promptSnippet: "Inspect the score and summary of a trajectory when it looks useful",
    parameters: Type.Object(identifier, { additionalProperties: false }),
    async execute(_id, params) {
      try { return ok(await requestAuthority({ op: "experience-get", identifier: idOf(params) })); }
      catch (error) { return failed(error); }
    },
  });

  pi.registerTool({
    name: "cad_experience_find",
    label: "Find in CAD Experience",
    description: "Find keyword matches with bounded surrounding lines in one prior trajectory.",
    promptSnippet: "Find passages you want to learn from in a prior trajectory",
    parameters: Type.Object({ ...identifier, query: Type.String({ minLength: 1 }), context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
    async execute(_id, params) {
      try { return ok(await requestAuthority({ op: "experience-find", identifier: idOf(params), query: params.query, context: params.context, limit: params.limit })); }
      catch (error) { return failed(error); }
    },
  });

  pi.registerTool({
    name: "cad_experience_read",
    label: "Read CAD Experience",
    description: "Read a bounded line range from one prior trajectory; never loads a full long transcript by default.",
    promptSnippet: "Read a bounded section of a prior trajectory when you want more detail",
    parameters: Type.Object({ ...identifier, start_line: Type.Optional(Type.Integer({ minimum: 1 })), end_line: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
    async execute(_id, params) {
      try { return ok(await requestAuthority({ op: "experience-read", identifier: idOf(params), startLine: params.start_line, endLine: params.end_line })); }
      catch (error) { return failed(error); }
    },
  });
}
