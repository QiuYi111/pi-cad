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
 * The conversation whose workflow state the Desktop projects. `undefined`
 * means unbound: the UI shows no run instead of the previous one.
 */
export function projectedSessionId(selection: ConversationSelection, liveSessionId?: string): string | undefined {
  return selection.pendingNew ? undefined : liveSessionId;
}
