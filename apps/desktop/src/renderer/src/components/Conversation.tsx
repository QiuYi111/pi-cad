import { Box } from "./icons";
import type { ChatMessage } from "@shared/contracts";
import { ActivityCard } from "./ActivityCard";

export function Conversation({ messages }: { messages: ChatMessage[] }) {
  return <div className="conversation" data-testid="conversation">
    {messages.map((message) => message.activity
      ? <ActivityCard key={message.id} activity={message.activity} />
      : message.role === "user"
        ? <div key={message.id} className="user-message">{message.text}</div>
        : <div key={message.id} className="assistant-message"><Box size={16} /><div>{message.text}</div></div>)}
  </div>;
}
