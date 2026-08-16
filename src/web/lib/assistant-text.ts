import type { PiContentBlock, PiMessage } from "../../shared/types";

const REPEATED_ANALYSIS_CHANNEL = /code\*\*\/analysis(?:\s*code\*\*\/analysis){2,}/;
const LEAKED_THINKING_TITLE = /^\s*\*\*(?:analyzing|planning|designing|checking|reviewing|inspecting|examining|looking|reading|searching|considering|evaluating|investigating|identifying|locating|confirming|preparing|writing|implementing|fixing|optimizing|debugging|testing)\b[^*\r\n]{0,160}(?:\*\*)?\s*$/i;
// Some providers can emit an internal task-restatement as visible assistant
// text. Keep the match deliberately narrow: a normal quoted sentence lacks
// the private-process continuation ("Let me" or "I need to").
const LEAKED_PRIVATE_PROCESS_PREAMBLE = /^\s*The user wants me to\b(?=[\s\S]*\b(?:let me|i need to)\b)[\s\S]*$/i;

/**
 * Remove a provider's private-progress-title dump without touching ordinary
 * Markdown. A run must contain at least three title-only lines and either a
 * duplicate title or five titles, so a normal short outline remains visible.
 */
function stripLeakedThinkingTitleRun(value: string): string {
  const lines = value.split(/(\r?\n)/);
  const output: string[] = [];
  let run: string[] = [];
  let titleCount = 0;
  const titles = new Map<string, number>();

  const flush = () => {
    const repeated = [...titles.values()].some((count) => count > 1);
    if (titleCount < 3 || (!repeated && titleCount < 5)) output.push(...run);
    run = [];
    titleCount = 0;
    titles.clear();
  };

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const newline = lines[index + 1] || "";
    if (LEAKED_THINKING_TITLE.test(line)) {
      run.push(line, newline);
      titleCount += 1;
      const title = line.trim().replace(/^\*\*|\*\*$/g, "").trim().toLowerCase();
      titles.set(title, (titles.get(title) || 0) + 1);
    } else if (run.length && !line.trim()) {
      run.push(line, newline);
    } else {
      flush();
      output.push(line, newline);
    }
  }
  flush();
  return output.join("");
}

/**
 * Hide a malformed provider/protocol artifact that can occasionally be
 * emitted into an assistant text block instead of its private thinking block.
 * Requiring three consecutive markers avoids altering ordinary discussions
 * or code samples that mention the word "analysis".
 */
export function sanitizeAssistantText(value: string): string {
  const titleCleaned = stripLeakedThinkingTitleRun(value);
  if (LEAKED_PRIVATE_PROCESS_PREAMBLE.test(titleCleaned)) return "";
  const match = REPEATED_ANALYSIS_CHANNEL.exec(titleCleaned);
  if (!match || match.index === undefined) return titleCleaned;

  let start = match.index;
  const thinkingStart = titleCleaned.lastIndexOf("<thinking>", start);
  if (thinkingStart >= 0 && titleCleaned.slice(thinkingStart, start).includes("**/analysis")) start = thinkingStart;

  let before = titleCleaned.slice(0, start);
  let after = titleCleaned.slice(match.index + match[0].length);

  // Remove only one separator created by joining around the leaked run. Never
  // trim the complete Markdown block: leading indentation, hard-break spaces,
  // fences and final newlines may all be semantically meaningful.
  if (before.endsWith("\r\n") && after.startsWith("\r\n")) after = after.slice(2);
  else if (before.endsWith("\n") && after.startsWith("\n")) after = after.slice(1);
  else if (/[ \t]$/.test(before) && /^[ \t]/.test(after)) after = after.slice(1);
  else if (!before && start === 0 && /^[ \t]/.test(after)) after = after.slice(1);

  return `${before}${after}`;
}

/** Content that ChatMessage can actually paint for an assistant response. */
export function visibleAssistantBlocks(message: PiMessage): PiContentBlock[] {
  const content = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content || [];
  const visible: PiContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      const text = sanitizeAssistantText(block.text);
      if (text.trim()) visible.push({ ...block, text });
    } else if (block.type === "image" && block.data && block.mimeType) {
      visible.push(block);
    }
  }
  return visible;
}

export function visibleAssistantMessage(message: PiMessage): PiMessage | undefined {
  if (message.role !== "assistant") return message;
  const visible = visibleAssistantBlocks(message);
  if (!visible.length) return undefined;
  const content = typeof message.content === "string" && visible.length === 1 && visible[0].type === "text"
    ? visible[0].text || ""
    : visible;
  return { ...message, content };
}
