import type { AskQuestionnairePlan } from "../lib/ask-questionnaire";

/**
 * Ephemeral browser projection of the current ask_user_question tool calls.
 * It is process-owned UI state: Pi events create or retire it, and a server
 * replacement resets it. It is never a persisted Session or Pane authority.
 */
export type AskQuestionnaireState = Readonly<Record<string, AskQuestionnairePlan>>;

export type AskQuestionnaireAction =
  | { type: "OPEN"; sessionId: string; questionnaire: AskQuestionnairePlan }
  | { type: "CLOSE_IF_MATCH"; sessionId: string; toolCallId: string }
  | { type: "CLOSE_SESSION"; sessionId: string }
  | { type: "RESET" };

export function emptyAskQuestionnaireState(): AskQuestionnaireState {
  return {};
}

export function askQuestionnaireReducer(
  state: AskQuestionnaireState,
  action: AskQuestionnaireAction,
): AskQuestionnaireState {
  switch (action.type) {
    case "OPEN":
      return {
        ...state,
        [action.sessionId]: action.questionnaire,
      };
    case "CLOSE_IF_MATCH": {
      const active = state[action.sessionId];
      if (!active || active.toolCallId !== action.toolCallId) return state;
      const next = { ...state };
      delete next[action.sessionId];
      return next;
    }
    case "CLOSE_SESSION": {
      if (!state[action.sessionId]) return state;
      const next = { ...state };
      delete next[action.sessionId];
      return next;
    }
    case "RESET":
      return emptyAskQuestionnaireState();
  }
}
