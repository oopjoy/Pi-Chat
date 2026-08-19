import assert from "node:assert/strict";
import test from "node:test";
import {
  askQuestionnaireReducer,
  emptyAskQuestionnaireState,
} from "../src/web/state/ask-questionnaire";
import type { AskQuestionnairePlan } from "../src/web/lib/ask-questionnaire";

const one: AskQuestionnairePlan = {
  toolCallId: "ask-one",
  questions: [{
    question: "Choose one?",
    header: "Question",
    options: [
      { label: "One", description: "first" },
      { label: "Two", description: "second" },
    ],
    multiSelect: false,
  }],
};

const two: AskQuestionnairePlan = { ...one, toolCallId: "ask-two" };

test("an Ask close only retires the matching tool call for its Session", () => {
  const opened = askQuestionnaireReducer(emptyAskQuestionnaireState(), {
    type: "OPEN",
    sessionId: "session-a",
    questionnaire: one,
  });
  const replaced = askQuestionnaireReducer(opened, {
    type: "OPEN",
    sessionId: "session-a",
    questionnaire: two,
  });
  assert.equal(
    askQuestionnaireReducer(replaced, {
      type: "CLOSE_IF_MATCH",
      sessionId: "session-a",
      toolCallId: "ask-one",
    }),
    replaced,
    "a late terminal for A's old tool cannot close a newer questionnaire",
  );
  assert.deepEqual(
    askQuestionnaireReducer(replaced, {
      type: "CLOSE_IF_MATCH",
      sessionId: "session-a",
      toolCallId: "ask-two",
    }),
    {},
  );
});

test("Ask terminal and process reset actions do not affect other Sessions", () => {
  const state = askQuestionnaireReducer(
    askQuestionnaireReducer(emptyAskQuestionnaireState(), {
      type: "OPEN",
      sessionId: "session-a",
      questionnaire: one,
    }),
    {
      type: "OPEN",
      sessionId: "session-b",
      questionnaire: two,
    },
  );
  assert.deepEqual(
    askQuestionnaireReducer(state, {
      type: "CLOSE_SESSION",
      sessionId: "session-a",
    }),
    { "session-b": two },
  );
  assert.deepEqual(askQuestionnaireReducer(state, { type: "RESET" }), {});
});
