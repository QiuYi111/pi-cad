import { memo, useEffect, useRef, useState } from "react";
import { Box } from "./icons";
import { runtimeTurnActive, type ChatMessage, type RuntimeStatus } from "@shared/contracts";
import { ActivityCard } from "./ActivityCard";
import { MarkdownText } from "./MarkdownText";
import { turnPhaseView, turnTimerParts } from "../lib/runtime-phase";

export function Conversation({ messages, status, onReadingChange, onReference, onEdit }: { messages: ChatMessage[]; status: RuntimeStatus; onReadingChange?: (reading: boolean) => void; onReference?: (text: string) => void; onEdit?: (text: string) => void }) {
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
        : <AssistantMessage key={message.id} message={message} status={status} />)}
    <TurnPhaseRow status={status} />
  </div>;
}

/**
 * The running turn as the runtime reports it. The row belongs to the runtime,
 * not to a message, so a tool call or a retry cannot hide it.
 */
const TurnPhaseRow = memo(function TurnPhaseRow({ status }: { status: RuntimeStatus }) {
  const [, tick] = useState(0);
  const view = turnPhaseView(status, Date.now());
  const active = Boolean(view && !view.terminal);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!view) return null;
  return <div className={`conversation-turn stream-state ${view.phase}`} data-terminal-reason={view.terminal ? status.terminalReason : undefined}>
    <i /><span>{view.label}</span>
    {turnTimerParts(view).map((part) => <time key={part.key} data-timer={part.key}>{part.text}</time>)}
  </div>;
});

const AssistantMessage = memo(function AssistantMessage({ message, status }: { message: ChatMessage; status: RuntimeStatus }) {
  const active = Boolean(message.stream && !message.stream.finishedAt) && runtimeTurnActive(status);
  return <div className={`assistant-message ${active ? "streaming" : ""}`}><Box size={16} /><div>
    {message.text && <div className="assistant-text"><MarkdownText text={message.text} />{active && status.phase === "responding" && <span className="stream-caret" />}</div>}
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
