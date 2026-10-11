import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

interface MarkdownNode {
  type?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: MarkdownNode[];
}
interface Range { start: number; end: number }
export interface LatexMathRange extends Range {
  display: boolean;
  closed: boolean;
}

// Use Markdown's code/link positions, not regex-only fence/backtick guesses.
// Do not enable GFM: pipes in TeX must not corrupt the ranges in table cells.
const parser = unified().use(remarkParse).use(remarkMath).freeze();
const literalNodes = new Set(["code", "inlineCode", "html", "link", "image", "definition", "math", "inlineMath"]);

function literalRanges(source: string): Range[] {
  const ranges: Range[] = [];
  const visit = (node: MarkdownNode) => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (literalNodes.has(node.type || "") && typeof start === "number" && typeof end === "number") {
      ranges.push({ start, end });
      return;
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(source) as MarkdownNode);
  // GFM bare URLs are not links in the non-GFM tree. Also leave bare Windows
  // paths alone: C:\(folder\) is not a request to render an equation.
  for (const match of source.matchAll(/\b(?:https?:\/\/|www\.|[A-Za-z]:[\\/])[^\s<>]*/g))
    ranges.push({ start: match.index, end: match.index + match[0].length });
  for (const match of source.matchAll(/<(code|pre|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi))
    ranges.push({ start: match.index, end: match.index + match[0].length });
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Paired, unescaped LaTeX delimiters outside literal Markdown regions.
 * Streaming also asks for unfinished ranges so blank lines cannot freeze half
 * an equation. A heading/fence (or blank paragraph for inline math) bounds a
 * malformed opening locally. One scan avoids quadratic unmatched-open retries.
 */
export function latexMathRanges(source: string, includeUnclosed = false): LatexMathRange[] {
  if (!/\\(?:\(|\[)/.test(source)) return [];
  let literals: Range[];
  try { literals = literalRanges(source); } catch { return []; }
  const ranges: LatexMathRange[] = [];
  let literal = 0;
  let pending: { start: number; display: boolean } | null = null;
  const abandon = (end: number) => {
    if (pending && includeUnclosed) ranges.push({ ...pending, end, closed: false });
    pending = null;
  };
  for (let cursor = 0; cursor < source.length;) {
    if (pending && (cursor === 0 || source[cursor - 1] === "\n")) {
      const end = source.indexOf("\n", cursor);
      const line = source.slice(cursor, end < 0 ? source.length : end).replace(/\r$/, "");
      const structural = /^(?: {0,3}>[ \t]?)* {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,})/.test(line);
      const blank = /^(?: {0,3}>[ \t]?)*[ \t]*$/.test(line);
      if (structural || (!pending.display && blank)) abandon(cursor);
    }
    if (!pending) {
      while (literal < literals.length && literals[literal].end <= cursor) literal++;
      if (literal < literals.length && literals[literal].start <= cursor) {
        cursor = literals[literal].end;
        continue;
      }
    }
    if (source[cursor] !== "\\") { cursor++; continue; }
    const next = source[cursor + 1];
    if (next === "\\") { cursor += 2; continue; }
    if (pending && next === (pending.display ? "]" : ")")) {
      ranges.push({ ...pending, end: cursor + 2, closed: true });
      pending = null;
      cursor += 2;
    } else if (next === "(" || next === "[") {
      abandon(cursor);
      pending = { start: cursor, display: next === "[" };
      cursor += 2;
    } else { cursor++; }
  }
  abandon(source.length);
  return ranges;
}

function containerPrefix(source: string, offset: number): { prefix: string; ownLine: boolean } {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const before = source.slice(lineStart, offset);
  const match = before.match(/^((?: {0,3}>[ \t]?)*[ \t]*)(?:(?:[-+*]|\d+[.)])([ \t]+))?/);
  const raw = match?.[0] || "";
  const quoteIndent = match?.[1] || "";
  return { prefix: quoteIndent + " ".repeat(raw.length - quoteIndent.length), ownLine: raw === before };
}

/** Rewrite only the rendering copy, carrying exact UTF-16 source boundaries. */
export function normalizeLatexDelimiters(source: string, trackOffsets: boolean) {
  const ranges = latexMathRanges(source).filter(range => source.slice(range.start + 2, range.end - 2).trim());
  if (!ranges.length) return { markdown: source, mapOffset: (offset: number) => offset };
  const output: string[] = [];
  const boundaries = trackOffsets ? [0] : null;
  const original = (start: number, end: number) => {
    output.push(source.slice(start, end));
    if (boundaries) for (let i = start + 1; i <= end; i++) boundaries.push(i);
  };
  const inserted = (text: string, offset: number) => {
    output.push(text);
    if (boundaries) for (let i = 0; i < text.length; i++) boundaries.push(offset);
  };
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let cursor = 0;
  let previousRange: LatexMathRange | undefined;
  for (const range of ranges) {
    original(cursor, range.start);
    const bodyStart = range.start + 2;
    const bodyEnd = range.end - 2;
    const body = source.slice(bodyStart, bodyEnd);
    // TeX may itself contain $ (e.g. \text{\$5}); a longer delimiter keeps it
    // inside one math node rather than letting remark-math close it early.
    let longestDollar = 0;
    for (const match of body.matchAll(/\$+/g)) longestDollar = Math.max(longestDollar, match[0].length);
    const marker = "$".repeat(Math.max(range.display ? 2 : 1, longestDollar + 1));
    if (!range.display) {
      // Adjacent formulas must not merge their closing/opening dollar runs.
      // An inline comment is invisible and maps to the same source boundary.
      if (source[range.start - 1] === "$" || (previousRange?.end === range.start && !previousRange.display))
        inserted("<!-- -->", range.start);
      inserted(`${marker} `, range.start);
      if (boundaries) boundaries[boundaries.length - 1] = bodyStart;
      original(bodyStart, bodyEnd);
      inserted(` ${marker}`, bodyEnd);
      if (boundaries) boundaries[boundaries.length - 1] = range.end;
      if (source[range.end] === "$") inserted("<!-- -->", range.end);
    } else {
      const opening = containerPrefix(source, range.start);
      if (!opening.ownLine) inserted(eol + opening.prefix, range.start);
      inserted(marker, range.start);
      if (boundaries) boundaries[boundaries.length - 1] = bodyStart;
      if (!/^\r?\n/.test(body)) inserted(eol + opening.prefix, bodyStart);
      original(bodyStart, bodyEnd);
      if (!containerPrefix(source, bodyEnd).ownLine) inserted(eol + opening.prefix, bodyEnd);
      inserted(marker, bodyEnd);
      if (boundaries) boundaries[boundaries.length - 1] = range.end;
      const nextNewline = source.indexOf("\n", range.end);
      const rest = source.slice(range.end, nextNewline < 0 ? source.length : nextNewline);
      if (rest.trim()) inserted(eol + opening.prefix, range.end);
    }
    cursor = range.end;
    previousRange = range;
  }
  original(cursor, source.length);
  return {
    markdown: output.join(""),
    mapOffset: (offset: number) => boundaries
      ? boundaries[Math.max(0, Math.min(offset, boundaries.length - 1))]
      : offset,
  };
}
