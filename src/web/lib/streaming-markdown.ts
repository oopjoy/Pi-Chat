export type StreamingMarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "paragraph"; text: string };

const headingPattern = /^ {0,3}(#{1,4})\s+(.+?)\s*#*\s*$/;
const unorderedListPattern = /^ {0,3}[-+*]\s+(.+)$/;
const orderedListPattern = /^ {0,3}\d+[.)]\s+(.+)$/;
const quotePattern = /^ {0,3}>\s?(.*)$/;
const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const codeLanguagePattern = /^[A-Za-z0-9_+.-]+$/;

function fenceCloses(line: string, marker: string): boolean {
  const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(
    close
    && close[1][0] === marker[0]
    && close[1].length >= marker.length,
  );
}

function fenceLanguage(value: string): string {
  const candidate = value.trim().split(/\s+/, 1)[0] || "";
  return codeLanguagePattern.test(candidate) ? candidate : "text";
}

function startsBlock(line: string): boolean {
  return Boolean(
    !line.trim()
    || headingPattern.test(line)
    || unorderedListPattern.test(line)
    || orderedListPattern.test(line)
    || quotePattern.test(line)
    || fencePattern.test(line),
  );
}

/**
 * Deliberately conservative streaming presentation. It handles only stable
 * line-oriented structure and leaves tables, inline math, HTML, and unfinished
 * inline syntax as literal text until the terminal full Markdown pass.
 */
export function streamingMarkdownBlocks(source: string): StreamingMarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: StreamingMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = fencePattern.exec(line);
    if (fence) {
      const marker = fence[1];
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !fenceCloses(lines[index], marker)) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        kind: "code",
        language: fenceLanguage(fence[2]),
        text: code.join("\n"),
      });
      continue;
    }

    const heading = headingPattern.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2],
      });
      index += 1;
      continue;
    }

    const unordered = unorderedListPattern.exec(line);
    const ordered = orderedListPattern.exec(line);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const item = (orderedList ? orderedListPattern : unorderedListPattern).exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ kind: "list", ordered: orderedList, items });
      continue;
    }

    const quote = quotePattern.exec(line);
    if (quote) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const next = quotePattern.exec(lines[index]);
        if (!next) break;
        quoted.push(next[1]);
        index += 1;
      }
      blocks.push({ kind: "quote", text: quoted.join("\n") });
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}
