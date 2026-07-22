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
