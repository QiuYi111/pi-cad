/**
 * Build the compact, agent-facing view of an archived Prime trajectory.
 *
 * The raw JSONL and Transcript Lab output remain the forensic authority. This
 * view deliberately excludes harness policy, skill manuals, phase cards, and
 * recursive experience lookups: those describe the runtime, not transferable
 * engineering experience.
 */

export interface ExperienceViewMetadata {
  workflow: string;
  outcome?: "complete" | "clarification_required" | "incomplete";
  outcomeReason?: string;
  model?: string | null;
  reasoning?: string | null;
}

const MAX_TOOL_RESULT_CHARS = 12_000;
const EXPERIENCE_TOOLS = /^cad_experience_(?:search|get|find|read)$/;
const PHASE_CARD_MARKERS = /(?:pi-cad\.phase-card|\bWHERE\s*\n\s*GOAL\s*\n\s*SOP\b)/i;
const SKILL_READ_MARKERS = /(?:\bSKILL\.md\b|\/opt\/pi-cad\/cad\/|#\s*Pi-CAD Python API|name:\s*cad\b)/i;
const WORKFLOW_META_CALL = /cad\.workflow\.(?:list|current|start|advance)/;

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return [record.text];
    return [];
  });
}

export function stripRuntimePrompt(text: string): string {
  const benchmarkContract = text.search(/\n\s*Benchmark execution contract:/i);
  const phaseCard = text.search(/\n?\s*\[?pi-cad\.phase-card\]?/i);
  const cut = [benchmarkContract, phaseCard].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  return (cut === undefined ? text : text.slice(0, cut)).trim();
}

function toolName(item: Record<string, unknown>): string {
  return String(item.name || item.toolName || "tool");
}

function toolArguments(item: Record<string, unknown>): unknown {
  return item.arguments ?? item.input ?? item.args ?? {};
}

function isRuntimeOnlyTool(name: string, serializedArguments: string): boolean {
  return EXPERIENCE_TOOLS.test(name)
    || (name === "ipython" && SKILL_READ_MARKERS.test(serializedArguments));
}

function compactWorkflowState(text: string): string {
  const fields = ["runId", "workflowId", "phase", "status", "outcome"];
  const found: string[] = [];
  for (const field of fields) {
    const match = text.match(new RegExp(`["']${field}["']\\s*:\\s*["']([^"']+)["']`, "i"));
    if (match) found.push(`${field}=${match[1]}`);
  }
  if (found.length) return `[workflow state: ${found.join(", ")}]`;
  if (/^\s*None\b/.test(text)) return "[workflow state: not started]";
  return "[workflow state updated]";
}

function cleanToolResult(name: string, text: string): string {
  if (EXPERIENCE_TOOLS.test(name) || SKILL_READ_MARKERS.test(text)) return "";
  if (/cad\.workflow\.(?:list|current|start|advance)|workflowId|effectiveCapabilities/.test(text)) {
    return compactWorkflowState(text);
  }
  const withoutPayloads = text
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/gi, "[image omitted]")
    .replace(/[A-Za-z0-9+/]{4096,}={0,2}/g, "[binary payload omitted]");
  return withoutPayloads.length > MAX_TOOL_RESULT_CHARS
    ? `${withoutPayloads.slice(0, MAX_TOOL_RESULT_CHARS)}\n[tool result truncated]`
    : withoutPayloads;
}

function renderFallback(record: Record<string, unknown>): string {
  if (typeof record.message === "string") return record.message.trim();
  return "";
}

export function renderExperienceView(raw: string, metadata: ExperienceViewMetadata): string {
  const sections: string[] = [
    "# Engineering trajectory",
    "",
    "## Meta state",
    `- workflow: ${metadata.workflow}`,
    `- outcome: ${metadata.outcome || "unknown"}`,
    ...(metadata.outcomeReason ? [`- outcome reason: ${metadata.outcomeReason}`] : []),
    ...(metadata.model ? [`- model: ${metadata.model}`] : []),
    ...(metadata.reasoning ? [`- reasoning: ${metadata.reasoning}`] : []),
  ];
  const omittedCallIds = new Set<string>();
  const workflowCallIds = new Set<string>();
  let taskWritten = false;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (record.type !== "message" || !record.message || typeof record.message !== "object") {
      const fallback = renderFallback(record);
      if (fallback) sections.push("", "## Event", fallback);
      continue;
    }
    const message = record.message as Record<string, unknown>;
    const role = String(message.role || "");

    if (role === "user") {
      if (taskWritten) continue;
      const text = stripRuntimePrompt(textBlocks(message.content).join("\n"));
      if (!text || PHASE_CARD_MARKERS.test(text)) continue;
      sections.push("", "## Task", text);
      taskWritten = true;
      continue;
    }

    if (role === "assistant" && Array.isArray(message.content)) {
      const prose: string[] = [];
      for (const rawItem of message.content) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string" && !PHASE_CARD_MARKERS.test(item.text)) {
          prose.push(item.text.trim());
        } else if (item.type === "thinking" && typeof item.thinking === "string") {
          prose.push(`[decision] ${item.thinking.trim()}`);
        } else if (item.type === "toolCall") {
          const name = toolName(item);
          const args = toolArguments(item);
          const serialized = JSON.stringify(args, null, 2);
          const callId = String(item.id || item.toolCallId || "");
          if (isRuntimeOnlyTool(name, serialized)) {
            if (callId) omittedCallIds.add(callId);
            continue;
          }
          if (name === "ipython" && WORKFLOW_META_CALL.test(serialized)) {
            if (callId) workflowCallIds.add(callId);
            continue;
          }
          prose.push(`### Tool: ${name}\n\n\`\`\`json\n${serialized}\n\`\`\``);
        }
      }
      if (prose.length) sections.push("", "## Agent", prose.join("\n\n"));
      continue;
    }

    if (role === "toolResult") {
      const name = String(message.toolName || "tool");
      const callId = String(message.toolCallId || "");
      if (omittedCallIds.has(callId) || EXPERIENCE_TOOLS.test(name)) continue;
      const rawText = textBlocks(message.content).join("\n");
      const text = workflowCallIds.has(callId) ? compactWorkflowState(rawText) : cleanToolResult(name, rawText);
      if (text.trim()) sections.push("", `## Result: ${name}`, text.trim());
    }
  }

  return `${sections.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
