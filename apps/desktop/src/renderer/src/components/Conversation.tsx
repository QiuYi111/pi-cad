import { useEffect, useRef, useState } from "react";
import { Box } from "./icons";
import type { ChatMessage } from "@shared/contracts";
import { ActivityCard } from "./ActivityCard";

export function Conversation({ messages }: { messages: ChatMessage[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (follow.current) ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" }); }, [messages]);
  return <div ref={ref} className="conversation" data-testid="conversation" onScroll={() => {
    const node = ref.current;
    if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
  }}>
    {messages.map((message) => message.activity
      ? <ActivityCard key={message.id} activity={message.activity} />
      : message.role === "user"
        ? <div key={message.id} className="user-message">{message.text}</div>
        : <AssistantMessage key={message.id} message={message} />)}
  </div>;
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  const [, tick] = useState(0);
  const active = Boolean(message.stream && !["complete", "aborted", "error"].includes(message.stream.state));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const seconds = message.stream ? Math.max(0, Math.floor(((message.stream.finishedAt || Date.now()) - message.stream.startedAt) / 1_000)) : 0;
  const label = message.stream?.state === "waiting" ? "Waiting for model" : message.stream?.state === "thinking" ? "Thinking" : message.stream?.state === "responding" ? "Responding" : message.stream?.state === "aborted" ? "Stopped" : message.stream?.state === "error" ? "Failed" : "";
  return <div className={`assistant-message ${active ? "streaming" : ""}`}><Box size={16} /><div>
    {label && <div className={`stream-state ${message.stream?.state}`}><i /><span>{label}</span>{seconds > 0 && <time>{seconds}s</time>}</div>}
    {message.text && <div className="assistant-text">{message.text}{active && message.stream?.state === "responding" && <span className="stream-caret" />}</div>}
  </div></div>;
}
