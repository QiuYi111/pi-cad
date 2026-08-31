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
  const values = result?.details?.attachments || result?.attachments || [];
  return values.flatMap((item: any, index: number) => {
    const mimeType = item.mimeType || item.mime_type;
    if (!mimeType?.startsWith("image/")) return [];
    return [{
      id: `${id}-media-${index}`,
      mimeType,
      role: item.role || item.label || "Tool output",
      dataUrl: item.data ? `data:${mimeType};base64,${item.data}` : undefined,
      path: item.path,
      label: item.label,
    }];
  });
}

export function reducePrimeEvent(messages: ChatMessage[], input: any): ChatMessage[] {
  if (input?.type === "desktop_user_message") {
    return [...messages, { id: input.id, role: "user", text: input.text, createdAt: Date.now() }];
  }
  const event = input?.type === "session_event" ? input.event : input;
  if (!event || typeof event !== "object") return messages;
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
      return {
        ...message,
        activity: {
          ...activity,
          state: event.isError || event.result?.isError ? "failed" : "success",
          title: completedTitle(activity.kind, event.isError || event.result?.isError),
          summary: concise(content) || activity.summary,
          progress: 1,
          finishedAt: Date.now(),
          media,
          details: event.result,
        },
      };
    });
  }
  if (event.type === "message_end") {
    const message = event.message;
    if (message?.role === "assistant") {
      const text = textOf(message.content).trim();
      if (text) return [...messages, { id: message.id || crypto.randomUUID(), role: "assistant", text, createdAt: Date.now() }];
    }
    if (message?.role === "custom" && message.customType === "pi-cad.review-completed") {
      const details = message.details || {};
      const result = details.result || {};
      const activity: CadActivity = {
        id: details.reviewId || crypto.randomUUID(), kind: "review",
        state: details.status === "pass" ? "success" : details.status === "fail" ? "failed" : "denied",
        title: details.status === "pass" ? "Review passed" : details.status === "fail" ? "Changes requested" : "Review unresolved",
        summary: result.summary || textOf(message.content), startedAt: Date.now(), finishedAt: Date.now(), details,
      };
      return [...messages, { id: `review-${activity.id}`, role: "system", text: "", createdAt: Date.now(), activity }];
    }
  }
  return messages;
}

function completedTitle(kind: CadActivity["kind"], failed: boolean): string {
  if (failed) return `${kind[0]!.toUpperCase()}${kind.slice(1)} failed`;
  return ({ build: "Model built", probe: "Geometry inspected", simulation: "Simulation complete", workflow: "Workflow advanced", review: "Review complete", commit: "Design state frozen", image: "Concept image generated" })[kind];
}

function concise(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}
