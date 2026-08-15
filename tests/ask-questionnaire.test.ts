import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  askAnswerComplete,
  askSubmissionStep,
  parseAskQuestionnaire,
  type AskQuestionAnswer,
} from "../src/web/lib/ask-questionnaire";

const args = {
  questions: [
    {
      question: "Choose a scope",
      header: "Scope",
      options: [
        { label: "Narrow", description: "Only the failing path" },
        { label: "Broad", description: "Refactor the surrounding code" },
      ],
      multiSelect: false,
    },
    {
      question: "Choose checks",
      header: "Checks",
      options: [
        { label: "Unit", description: "Run unit tests" },
        { label: "E2E", description: "Run browser tests" },
      ],
      multiSelect: true,
    },
  ],
};

test("ask questionnaire parser accepts the reviewed tool schema and rejects open shapes", () => {
  const plan = parseAskQuestionnaire("tool-1", args);
  assert.equal(plan?.questions.length, 2);
  assert.equal(plan?.questions[0].options[1].label, "Broad");
  assert.equal(parseAskQuestionnaire("", args), null);
  assert.equal(parseAskQuestionnaire("tool-1", { questions: [] }), null);
  assert.equal(parseAskQuestionnaire("tool-1", {
    questions: [{ ...args.questions[0], options: [{ label: "Only", description: "one" }] }],
  }), null);
});

test("ask questionnaire submission maps the completed wizard back onto scalar RPC requests", () => {
  const plan = parseAskQuestionnaire("tool-1", args)!;
  const optionAnswers: Array<AskQuestionAnswer | null> = [
    { kind: "options", selected: [1] },
    { kind: "options", selected: [0, 1] },
  ];
  const first = askSubmissionStep(plan, optionAnswers, {
    questionIndex: 0,
    phase: "question",
  }, {
    type: "extension_ui_request",
    id: "select-1",
    method: "select",
    title: "[Scope] Choose a scope",
    options: [
      "1. Narrow — Only the failing path",
      "2. Broad — Refactor the surrounding code",
      "3. Type something.",
    ],
  });
  assert.deepEqual(first, {
    body: { id: "select-1", value: "2. Broad — Refactor the surrounding code" },
    next: { questionIndex: 1, phase: "question" },
  });
  assert.deepEqual(askSubmissionStep(plan, optionAnswers, first!.next!, {
    type: "extension_ui_request",
    id: "input-2",
    method: "input",
    title: "[Checks] Choose checks\n\n1. Unit — Run unit tests\n2. E2E — Run browser tests\n\nEnter the numbers of all that apply, comma-separated (e.g. \"1,3\"), or type a custom answer as plain text.",
  }), {
    body: { id: "input-2", value: "1,2" },
    next: null,
  });
});

test("questionnaire options use one natural text flow and a stable inline custom row", () => {
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(css, /button\.ask-questionnaire-option:hover:not\(:disabled\)/);
  assert.match(css, /\.ask-questionnaire-option\.is-selected/);
  assert.match(css, /\.ask-questionnaire-option-copy \{[^}]*white-space: normal/);
  assert.match(css, /\.ask-questionnaire-option-copy small \{ display: inline;/);
  assert.match(css, /\.ask-questionnaire-custom \{[^}]*height: 42px;[^}]*gap: 10px/);
  assert.match(css, /\.ask-questionnaire-custom\.is-selected \.ask-questionnaire-option-marker/);
  assert.match(css, /\.ask-questionnaire-custom-trigger \{[^}]*height: 30px/);
  assert.match(css, /\.ask-questionnaire-custom input \{[^}]*height: 30px/);
});

test("custom answers use the sentinel and then answer the Package follow-up input", () => {
  const plan = parseAskQuestionnaire("tool-1", args)!;
  const answers: Array<AskQuestionAnswer | null> = [
    { kind: "custom", value: "My own scope" },
    { kind: "options", selected: [0] },
  ];
  const sentinel = askSubmissionStep(plan, answers, {
    questionIndex: 0,
    phase: "question",
  }, {
    type: "extension_ui_request",
    id: "select-custom",
    method: "select",
    title: "[Scope] Choose a scope",
    options: [
      "1. Narrow — Only the failing path",
      "2. Broad — Refactor the surrounding code",
      "3. Type something.",
    ],
  });
  assert.deepEqual(sentinel, {
    body: { id: "select-custom", value: "3. Type something." },
    next: { questionIndex: 0, phase: "custom-input" },
  });
  assert.deepEqual(askSubmissionStep(plan, answers, sentinel!.next!, {
    type: "extension_ui_request",
    id: "input-custom",
    method: "input",
    title: "[Scope] Choose a scope\n\nType your answer:",
  }), {
    body: { id: "input-custom", value: "My own scope" },
    next: { questionIndex: 1, phase: "question" },
  });
  assert.equal(askAnswerComplete({ kind: "custom", value: "   " }), false);
  assert.equal(askSubmissionStep(plan, answers, {
    questionIndex: 0,
    phase: "question",
  }, {
    type: "extension_ui_request",
    id: "mismatched",
    method: "select",
    title: "[Scope] Choose a scope",
    options: [
      "1. Broad — Refactor the surrounding code",
      "2. Narrow — Only the failing path",
      "3. Type something.",
    ],
  }), null, "reordered scalar options must never receive an automatic answer");
});
