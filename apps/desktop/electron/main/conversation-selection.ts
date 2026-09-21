/**
 * Which Prime conversation the Desktop shows workflow state for.
 *
 * Asking for a new conversation does not create an empty Prime transcript, so
 * between the click and the first prompt the Desktop has a selected
 * conversation that Prime has not opened yet. That selection is unbound on
 * purpose: it must not keep projecting the run of the conversation it
 * replaces.
 */
export interface ConversationSelection {
  /** A new conversation is selected; Prime has not created its session yet. */
  pendingNew: boolean;
  /** Session the new conversation replaces, when one was live. */
  replacedSessionId?: string;
}

export const NO_CONVERSATION: ConversationSelection = { pendingNew: false };

/** Follow the live Prime session (started or resumed). */
export function selectLiveSession(): ConversationSelection {
  return NO_CONVERSATION;
}

export function selectNewConversation(replacedSessionId?: string): ConversationSelection {
  return { pendingNew: true, ...(replacedSessionId ? { replacedSessionId } : {}) };
}

/**
 * The conversation whose workflow state the Desktop projects, as a request
 * scope. `null` means the Desktop window has no Prime session yet — between
 * the click on a new conversation and its first prompt, or before Prime has
 * started anything. A Desktop window is always conversation-scoped, so `null`
 * is unbound: the UI shows no run instead of the previous one. Only a caller
 * that has no window at all (headless, packaged smoke) names no conversation.
 */
export function projectedConversationScope(selection: ConversationSelection, liveSessionId?: string): string | null {
  return selection.pendingNew || !liveSessionId ? null : liveSessionId;
}
