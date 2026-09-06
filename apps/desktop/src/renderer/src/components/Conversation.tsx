import { memo, useEffect, useRef, useState } from "react";
import { Box } from "./icons";
import type { ChatMessage } from "@shared/contracts";
import { ActivityCard } from "./ActivityCard";
import { MarkdownText } from "./MarkdownText";

export function Conversation({ messages, onReadingChange, onReference, onEdit }: { messages: ChatMessage[]; onReadingChange?: (reading: boolean) => void; onReference?: (text: string) => void; onEdit?: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (follow.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [messages]);
  return <div ref={ref} className="conversation" data-testid="conversation" onScroll={() => {
    const node = ref.current;
    if (node) {
      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
      onReadingChange?.(!follow.current);
    }
  }}>
    {messages.map((message) => message.activity
      ? <ActivityCard key={message.id} activity={message.activity} onReference={onReference} />
      : message.role === "user"
        ? <UserMessage key={message.id} message={message} onEdit={onEdit} />
        : <AssistantMessage key={message.id} message={message} />)}
  </div>;
}

const AssistantMessage = memo(function AssistantMessage({ message }: { message: ChatMessage }) {
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
    {message.text && <div className="assistant-text"><MarkdownText text={message.text} />{active && message.stream?.state === "responding" && <span className="stream-caret" />}</div>}
  </div></div>;
});

function UserMessage({ message, onEdit }: { message: ChatMessage; onEdit?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(message.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };
  return <div className="user-message-wrap">
    <div className="user-message">{message.text}</div>
    <div className="user-message-actions">
      <button onClick={() => void copy()} aria-label="复制消息">{copied ? "已复制" : "复制"}</button>
      <button onClick={() => onEdit?.(message.text)} aria-label="编辑并重新发送">编辑</button>
    </div>
  </div>;
}
