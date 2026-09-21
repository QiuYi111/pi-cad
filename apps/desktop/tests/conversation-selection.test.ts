import { describe, expect, it } from "vitest";
import {
  NO_CONVERSATION,
  projectedConversationScope,
  selectNewConversation,
} from "../electron/main/conversation-selection";

describe("desktop conversation selection", () => {
  it("projects the live Prime session when no new conversation is selected", () => {
    expect(projectedConversationScope(NO_CONVERSATION, "session-a")).toBe("session-a");
    // A window Prime has not opened a session for is unbound, not stateless.
    expect(projectedConversationScope(NO_CONVERSATION, undefined)).toBeNull();
  });

  it("projects nothing while a new conversation has no Prime session yet", () => {
    const selected = selectNewConversation("session-a");
    // The previous conversation's run must not stay on screen.
    expect(projectedConversationScope(selected, "session-a")).toBeNull();
  });

  it("keeps the new conversation unbound until Prime opens its own session", () => {
    const selected = selectNewConversation("session-a");
    // Whatever Prime reports next, the pending selection stays unbound until
    // the new session is opened for this conversation.
    expect(projectedConversationScope(selected, "session-b")).toBeNull();
    expect(projectedConversationScope(selected, undefined)).toBeNull();
  });
});
