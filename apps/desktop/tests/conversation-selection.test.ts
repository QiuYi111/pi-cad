import { describe, expect, it } from "vitest";
import {
  NO_CONVERSATION,
  projectedSessionId,
  selectNewConversation,
} from "../electron/main/conversation-selection";

describe("desktop conversation selection", () => {
  it("projects the live Prime session when no new conversation is selected", () => {
    expect(projectedSessionId(NO_CONVERSATION, "session-a")).toBe("session-a");
    expect(projectedSessionId(NO_CONVERSATION, undefined)).toBeUndefined();
  });

  it("projects nothing while a new conversation has no Prime session yet", () => {
    const selected = selectNewConversation("session-a");
    // The previous conversation's run must not stay on screen.
    expect(projectedSessionId(selected, "session-a")).toBeUndefined();
  });

  it("keeps the new conversation unbound until Prime opens its own session", () => {
    const selected = selectNewConversation("session-a");
    // Whatever Prime reports next, the pending selection stays unbound until
    // the new session is opened for this conversation.
    expect(projectedSessionId(selected, "session-b")).toBeUndefined();
    expect(projectedSessionId(selected, undefined)).toBeUndefined();
  });
});
