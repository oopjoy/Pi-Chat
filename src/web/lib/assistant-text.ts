import type { PiContentBlock, PiMessage } from "../../shared/types";

const REPEATED_ANALYSIS_CHANNEL = /code\*\*\/analysis(?:\s*code\*\*\/analysis){2,}/;

/**
 * Hide a malformed provider/protocol artifact that can occasionally be
 * emitted into an assistant text block instead of its private thinking block.
 * Requiring three consecutive markers avoids altering ordinary discussions
 * or code samples that mention the word "analysis".
 */
export function sanitizeAssistantText(value: string): string {
  const match = REPEATED_ANALYSIS_CHANNEL.exec(value);
  if (!match || match.index === undefined) return value;

  let start = match.index;
  const thinkingStart = value.lastIndexOf("<thinking>", start);
  if (thinkingStart >= 0 && value.slice(thinkingStart, start).includes("**/analysis")) start = thinkingStart;

  let before = value.slice(0, start);
  let after = value.slice(match.index + match[0].length);

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
