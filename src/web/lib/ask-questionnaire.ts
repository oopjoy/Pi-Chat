import type { ExtensionUiRequest } from "../../shared/types";

export interface AskQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

export interface AskQuestionnairePlan {
  toolCallId: string;
  questions: AskQuestion[];
}

export type AskQuestionAnswer =
  | { kind: "options"; selected: number[] }
  | { kind: "custom"; value: string };

export interface AskSubmissionCursor {
  questionIndex: number;
  phase: "question" | "custom-input";
}

export interface AskSubmissionStep {
  body: { id: string; value: string };
  next: AskSubmissionCursor | null;
}

function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  if (!result || result.length > maximum) return null;
  return result;
}

export function parseAskQuestionnaire(
  toolCallId: unknown,
  args: unknown,
): AskQuestionnairePlan | null {
  if (typeof toolCallId !== "string" || !toolCallId) return null;
  if (!args || typeof args !== "object" || !Array.isArray((args as { questions?: unknown }).questions))
    return null;
  const source = (args as { questions: unknown[] }).questions;
  if (source.length < 1 || source.length > 4) return null;
  const questions: AskQuestion[] = [];
  for (const raw of source) {
    if (!raw || typeof raw !== "object") return null;
    const input = raw as Record<string, unknown>;
    const question = boundedString(input.question, 4_000);
    const header = boundedString(input.header, 16);
    if (!question || !header || !Array.isArray(input.options)) return null;
    if (input.options.length < 2 || input.options.length > 4) return null;
    const options: AskQuestionOption[] = [];
    for (const rawOption of input.options) {
      if (!rawOption || typeof rawOption !== "object") return null;
      const option = rawOption as Record<string, unknown>;
      const label = boundedString(option.label, 60);
      const description = boundedString(option.description, 4_000);
      if (!label || !description) return null;
      const preview = typeof option.preview === "string" && option.preview.trim()
        ? option.preview.slice(0, 10_000)
        : undefined;
      options.push({ label, description, preview });
    }
    questions.push({
      question,
      header,
      options,
      multiSelect: input.multiSelect === true,
    });
  }
  return { toolCallId, questions };
}

export function askAnswerComplete(answer: AskQuestionAnswer | null | undefined): boolean {
  if (!answer) return false;
  if (answer.kind === "custom") return answer.value.trim().length > 0;
  return answer.selected.length > 0;
}

const CUSTOM_SENTINEL_LABELS = new Set([
  "Type something.",
  "Введіть щось.",
  "Escribe algo.",
  "Écrivez quelque chose.",
  "Digite algo.",
  "Schreibe etwas.",
  "输入内容",
  "Escreva algo.",
  "Введите что-нибудь.",
]);
const CUSTOM_ANSWER_TITLES = new Set([
  "Type your answer:",
  "Введіть свою відповідь:",
  "Escribe tu respuesta:",
  "Tapez votre réponse :",
  "Digite sua resposta:",
  "Gib deine Antwort ein:",
  "输入你的回答：",
  "Escreva a sua resposta:",
  "Введите свой ответ:",
]);
const MULTI_SELECT_INSTRUCTIONS = new Set([
  'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.',
  'Введіть номери всіх відповідних варіантів через кому (наприклад, "1,3") або введіть власну відповідь текстом.',
  'Introduce los números de todas las opciones que apliquen, separados por comas (p. ej. "1,3"), o escribe una respuesta propia como texto.',
  'Saisissez les numéros de toutes les options applicables, séparés par des virgules (p. ex. « 1,3 »), ou tapez une réponse libre en texte.',
  'Digite os números de todas as opções aplicáveis, separados por vírgula (ex.: "1,3") ou digite uma resposta própria como texto.',
  'Gib die Nummern aller zutreffenden Optionen durch Komma getrennt ein (z. B. "1,3") oder tippe eine eigene Antwort als Text.',
  '输入所有适用选项的编号，用逗号分隔（例如 "1,3"），或直接输入自定义回答。',
  'Introduza os números de todas as opções aplicáveis, separados por vírgulas (ex.: "1,3") ou escreva uma resposta própria em texto.',
  'Введите номера всех подходящих вариантов через запятую (например, "1,3") или введите свой ответ текстом.',
]);

function baseTitle(question: AskQuestion): string {
  return `[${question.header}] ${question.question}`;
}

function formattedOptions(question: AskQuestion): string[] {
  return question.options.map((option, index) =>
    `${index + 1}. ${option.label} — ${option.description}`,
  );
}

function selectTitle(question: AskQuestion): string {
  const previews = question.options.flatMap((option, index) =>
    option.preview
      ? [`--- ${index + 1}. ${option.label} preview ---\n${option.preview.slice(0, 600)}`]
      : [],
  );
  return previews.length
    ? `${baseTitle(question)}\n\n${previews.join("\n\n")}`
    : baseTitle(question);
}

function validSingleSelectRequest(question: AskQuestion, request: ExtensionUiRequest): boolean {
  if (request.method !== "select" || request.title !== selectTitle(question)) return false;
  const options = request.options || [];
  const expected = formattedOptions(question);
  if (options.length !== expected.length + 1) return false;
  if (!expected.every((option, index) => options[index] === option)) return false;
  const sentinel = new RegExp(`^${expected.length + 1}\\.\\s*(.+)$`).exec(options[expected.length] || "");
  return Boolean(sentinel && CUSTOM_SENTINEL_LABELS.has(sentinel[1]));
}

function validCustomInputRequest(question: AskQuestion, request: ExtensionUiRequest): boolean {
  if (request.method !== "input") return false;
  const prefix = `${baseTitle(question)}\n\n`;
  return Boolean(
    request.title?.startsWith(prefix) &&
    CUSTOM_ANSWER_TITLES.has(request.title.slice(prefix.length)),
  );
}

function validMultiInputRequest(question: AskQuestion, request: ExtensionUiRequest): boolean {
  if (request.method !== "input") return false;
  const prefix = `${baseTitle(question)}\n\n${formattedOptions(question).join("\n")}\n\n`;
  return Boolean(
    request.title?.startsWith(prefix) &&
    MULTI_SELECT_INSTRUCTIONS.has(request.title.slice(prefix.length)),
  );
}

function nextQuestion(plan: AskQuestionnairePlan, questionIndex: number): AskSubmissionCursor | null {
  return questionIndex + 1 < plan.questions.length
    ? { questionIndex: questionIndex + 1, phase: "question" }
    : null;
}

export function askSubmissionStep(
  plan: AskQuestionnairePlan,
  answers: Array<AskQuestionAnswer | null>,
  cursor: AskSubmissionCursor,
  request: ExtensionUiRequest,
): AskSubmissionStep | null {
  const question = plan.questions[cursor.questionIndex];
  const answer = answers[cursor.questionIndex];
  if (!question || !askAnswerComplete(answer)) return null;
  if (cursor.phase === "custom-input") {
    if (!validCustomInputRequest(question, request) || answer?.kind !== "custom") return null;
    return {
      body: { id: request.id, value: answer.value },
      next: nextQuestion(plan, cursor.questionIndex),
    };
  }

  if (question.multiSelect) {
    if (!validMultiInputRequest(question, request)) return null;
    const value = answer?.kind === "custom"
      ? answer.value
      : (answer?.selected || []).map((index) => index + 1).join(",");
    return {
      body: { id: request.id, value },
      next: nextQuestion(plan, cursor.questionIndex),
    };
  }

  if (!validSingleSelectRequest(question, request)) return null;
  if (answer?.kind === "custom") {
    const sentinel = request.options?.[question.options.length];
    if (typeof sentinel !== "string") return null;
    return {
      body: { id: request.id, value: sentinel },
      next: { questionIndex: cursor.questionIndex, phase: "custom-input" },
    };
  }
  const selected = answer?.selected[0];
  const option = typeof selected === "number" ? request.options?.[selected] : undefined;
  if (typeof option !== "string") return null;
  return {
    body: { id: request.id, value: option },
    next: nextQuestion(plan, cursor.questionIndex),
  };
}
