import type { CadActivity, ChatMessage, MediaAttachment } from "@shared/contracts";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item: any) => item?.type === "text").map((item: any) => item.text || "").join("\n");
}

function classify(code: string): { kind: CadActivity["kind"]; title: string } | null {
  if (/cad\.model\.build/.test(code)) return { kind: "build", title: "Building model" };
  if (/cad\.probe\.run|@cad\.probe/.test(code)) return { kind: "probe", title: "Inspecting geometry" };
  if (/cad\.simulation\.run/.test(code)) return { kind: "simulation", title: "Running simulation" };
  if (/cad\.workflow\.advance/.test(code)) return { kind: "workflow", title: "Advancing workflow" };
  if (/cad\.workflow\.start/.test(code)) return { kind: "workflow", title: "Starting workflow" };
  if (/cad\.review\.submit/.test(code)) return { kind: "review", title: "Independent review" };
  if (/cad\.commit/.test(code)) return { kind: "commit", title: "Freezing design state" };
  if (/codex_generate_image/.test(code)) return { kind: "image", title: "Generating concept image" };
  return null;
}

function attachments(result: any, id: string): MediaAttachment[] {
  const values = [
    ...(Array.isArray(result?.details?.attachments) ? result.details.attachments : []),
    ...(Array.isArray(result?.attachments) ? result.attachments : []),
    ...(Array.isArray(result?.content) ? result.content.filter((item: any) => item?.type === "image" || item?.mimeType?.startsWith?.("image/") || item?.mime_type?.startsWith?.("image/")) : []),
  ];
  const seen = new Set<string>();
  return values.flatMap((item: any, index: number) => {
    const mimeType = item.mimeType || item.mime_type || "image/png";
    if (!mimeType?.startsWith("image/")) return [];
    const dataUrl = item.data ? `data:${mimeType};base64,${item.data}` : item.dataUrl || item.image_url;
    // Prime can expose the same inline image through both the tool content
    // and its attachment details. Keep one tile per rendered view; identical
    // pixels are duplicates, while the view-name banner makes distinct views
    // remain distinct even for symmetric geometry.
    const identity = dataUrl || item.path || `${mimeType}:${item.label || item.role || index}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{
      id: `${id}-media-${index}`,
      mimeType,
      role: item.role || item.label || "Tool output",
      dataUrl,
      path: item.path,
      label: item.label || item.name || item.view,
    }];
  });
}

function stepArtifact(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const match = value.match(/(?:[A-Za-z]:[\\/]|\/workspace\/|\/)[^\s"'<>]*?\.(?:step|stp)\b|(?:^|[\s"'])((?:[\w.-]+[\\/])*[\w.-]+\.(?:step|stp))\b/i);
    return (match?.[1] || match?.[0])?.trim().replace(/^["']/, "");
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = stepArtifact(item, depth + 1); if (found) return found; }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/artifact|path|step|output/i.test(key)) { const found = stepArtifact(item, depth + 1); if (found) return found; }
    }
    for (const item of Object.values(value)) { const found = stepArtifact(item, depth + 1); if (found) return found; }
  }
  return undefined;
}

function simulationOutputs(value: unknown, depth = 0): Array<{ name: string; type: string; path?: string; value?: number; unit?: string }> {
  if (depth > 8 || value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    const declared = value.filter((item: any) => item && typeof item === "object" && typeof item.name === "string" && typeof item.type === "string" && ["image", "scalar", "timeseries", "table", "field", "artifact"].includes(item.type));
    if (declared.length) return declared;
    return value.flatMap((item) => simulationOutputs(item, depth + 1));
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/exports|outputs|selected/i.test(key)) {
        const found = simulationOutputs(item, depth + 1);
        if (found.length) return found;
      }
    }
    for (const item of Object.values(value)) {
      const found = simulationOutputs(item, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

export function reducePrimeEvent(messages: ChatMessage[], input: any): ChatMessage[] {
  if (input?.type === "desktop_session_loaded") {
    const loaded = (input.messages || []).flatMap((message: any, index: number): ChatMessage[] => {
      if (message?.role !== "user" && message?.role !== "assistant") return [];
      const text = textOf(message.content).trim();
      if (!text) return [];
      return [{ id: message.id || `history-${index}`, role: message.role, text, createdAt: message.timestamp || Date.now() }];
    });
    return loaded.length ? loaded : [{ id: "welcome", role: "assistant", createdAt: Date.now(), text: "Welcome. I can help define requirements, explore concepts, build, inspect, and release this design." }];
  }
  if (input?.type === "desktop_event_batch") return (input.events || []).reduce((state: ChatMessage[], event: unknown) => reducePrimeEvent(state, event), messages);
  if (input?.type === "desktop_user_message") {
    return [...messages, { id: input.id, role: "user", text: input.text, createdAt: Date.now() }];
  }
  if (input?.type === "desktop_agent_pending") return reducePrimeEvent(messages, { type: "agent_start" });
  if (input?.type === "desktop_agent_error") {
    const next = finishOpenAssistant(messages, "error");
    const index = findLast(next, (message) => message.stream?.state === "error");
    return next.map((message, current) => current === index ? { ...message, text: message.text || input.message || "Prime failed to respond." } : message);
  }
  const event = input?.type === "session_event" ? input.event : input;
  if (!event || typeof event !== "object") return messages;
  if (event.type === "agent_start") {
    if (findOpenAssistant(messages) >= 0) return messages;
    const now = Date.now();
    return [...messages, { id: `stream-${now}`, role: "assistant", text: "", createdAt: now, stream: { state: "waiting", startedAt: now } }];
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (!update || (update.type !== "thinking_delta" && update.type !== "text_delta")) return messages;
    const now = Date.now();
    const index = findOpenAssistant(messages);
    const target: ChatMessage = index >= 0 ? messages[index]! : { id: event.message?.id || `stream-${now}`, role: "assistant", text: "", createdAt: now, stream: { state: "waiting", startedAt: now } };
    const next: ChatMessage = {
      ...target,
      text: update.type === "text_delta" ? `${target.text}${update.delta || ""}` : target.text,
      stream: { ...(target.stream!), state: update.type === "text_delta" ? "responding" : target.text ? "responding" : "thinking", firstTokenAt: target.stream?.firstTokenAt || now },
    };
    if (index < 0) return [...messages, next];
    return messages.map((message, current) => current === index ? next : message);
  }
  if (event.type === "tool_execution_start") {
    const code = event.args?.code || event.input?.code || JSON.stringify(event.args || event.input || {});
    const classified = classify(`${event.toolName || ""}\n${code}`);
    if (!classified) return messages;
    const activity: CadActivity = {
      id: event.toolCallId,
      ...classified,
      state: "running",
      summary: classified.kind === "build" ? "Source · STEP · Geometry · Views" : undefined,
      startedAt: Date.now(),
      progress: 0.35,
    };
    return [...messages, { id: `activity-${activity.id}`, role: "system", text: "", createdAt: Date.now(), activity }];
  }
  if (event.type === "tool_execution_update") {
    return messages.map((message): ChatMessage => {
      const activity = message.activity;
      if (!activity || activity.id !== event.toolCallId) return message;
      return { ...message, activity: { ...activity, stage: event.stage || event.message, progress: event.progress ?? activity.progress } };
    });
  }
  if (event.type === "tool_execution_end") {
    return messages.map((message): ChatMessage => {
      const activity = message.activity;
      if (!activity || activity.id !== event.toolCallId) return message;
      const media = attachments(event.result, event.toolCallId);
      const content = textOf(event.result?.content || event.result);
      const outputs = activity.kind === "simulation" ? simulationOutputs(event.result) : [];
      return {
        ...message,
        activity: {
          ...activity,
          state: event.isError || event.result?.isError ? "failed" : "success",
          title: completedTitle(activity.kind, event.isError || event.result?.isError),
          summary: activity.kind === "workflow" ? workflowSummary(event.result) : concise(content) || activity.summary,
          progress: 1,
          finishedAt: Date.now(),
          media,
          artifactPath: activity.kind === "build" ? stepArtifact(event.result) : activity.kind === "simulation" ? outputs.find((output) => output.path)?.path : undefined,
          metrics: activity.kind === "simulation" ? outputs.filter((output) => output.type === "scalar" && typeof output.value === "number").slice(0, 4).map((output) => ({ label: output.name, value: `${output.value}${output.unit ? ` ${output.unit}` : ""}` })) : activity.metrics,
          details: activity.kind === "simulation" && outputs.length ? { outputs } : undefined,
        },
      };
    });
  }
  if (event.type === "message_end") {
    const message = event.message;
    if (message?.role === "assistant") {
      const text = textOf(message.content).trim();
      const failed = message.stopReason === "error" || Boolean(message.errorMessage);
      const aborted = message.stopReason === "aborted";
      const state = failed ? "error" : aborted ? "aborted" : "complete";
      const fallback = String(message.errorMessage || (failed ? "Prime failed to respond." : aborted ? "Request was stopped." : ""));
      const index = findOpenAssistant(messages);
      if (index >= 0) {
        const now = Date.now();
        return messages.map((existing, current) => current === index ? { ...existing, id: message.id || existing.id, text: text || existing.text || fallback, stream: { ...existing.stream!, state, finishedAt: now } } : existing);
      }
      const visible = text || fallback;
      if (visible) {
        const previous = messages.at(-1);
        if (previous?.role === "assistant" && previous.text === visible && previous.stream?.state === state) return messages;
        const now = Date.now();
        return [...messages, { id: message.id || crypto.randomUUID(), role: "assistant", text: visible, createdAt: now, stream: { state, startedAt: now, finishedAt: now } }];
      }
    }
    if (message?.role === "custom" && message.customType === "pi-cad.review-completed") {
      const details = message.details || {};
      const result = details.result || {};
      const activity: CadActivity = {
        id: details.reviewId || crypto.randomUUID(), kind: "review",
        state: details.status === "pass" ? "success" : details.status === "fail" ? "failed" : "denied",
        title: details.status === "pass" ? "Review passed" : details.status === "fail" ? "Changes requested" : "Review unresolved",
        summary: result.summary || textOf(message.content), startedAt: Date.now(), finishedAt: Date.now(),
      };
      return [...messages, { id: `review-${activity.id}`, role: "system", text: "", createdAt: Date.now(), activity }];
    }
  }
  if (event.type === "agent_end") return finishOpenAssistant(messages, "complete");
  if (event.type === "agent_abort" || event.type === "abort") return finishOpenAssistant(messages, "aborted");
  if (event.type === "agent_error") return finishOpenAssistant(messages, "error");
  return messages;
}

function findOpenAssistant(messages: ChatMessage[]): number {
  return findLast(messages, (message) => message.role === "assistant" && Boolean(message.stream) && !["complete", "aborted", "error"].includes(message.stream!.state));
}

function findLast(messages: ChatMessage[], predicate: (message: ChatMessage) => boolean): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (predicate(messages[index]!)) return index;
  return -1;
}

function finishOpenAssistant(messages: ChatMessage[], state: "complete" | "aborted" | "error"): ChatMessage[] {
  const index = findOpenAssistant(messages);
  if (index < 0) return messages;
  return messages.map((message, current) => current === index ? { ...message, stream: { ...message.stream!, state, finishedAt: Date.now() } } : message);
}

function completedTitle(kind: CadActivity["kind"], failed: boolean): string {
  if (failed) return `${kind[0]!.toUpperCase()}${kind.slice(1)} failed`;
  return ({ build: "Model built", probe: "Geometry inspected", simulation: "Simulation complete", workflow: "Workflow advanced", review: "Review requested", commit: "Design state frozen", image: "Concept image generated" })[kind];
}

function concise(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function workflowSummary(result: unknown): string {
  const phase = findPhase(result);
  return phase ? `Now in ${phase.replaceAll("_", " ")}` : "Workflow state updated";
}

function findPhase(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["currentPhase", "current_phase", "targetPhase", "target_phase", "phase"]) {
      if (typeof record[key] === "string" && /^[a-z][a-z0-9_-]*$/i.test(record[key])) return record[key] as string;
    }
    for (const item of Object.values(record)) { const found = findPhase(item, depth + 1); if (found) return found; }
  }
  if (Array.isArray(value)) for (const item of value) { const found = findPhase(item, depth + 1); if (found) return found; }
  return undefined;
}
