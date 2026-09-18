import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface PreparedMarkdownMathPipes {
  markdown: string;
  tableMathPipeMarker?: string;
}

type MarkdownNode = {
  type?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  children?: MarkdownNode[];
};

// Parse math without GFM first: raw pipes cannot corrupt table columns before
// the same remark-math grammar has identified their exact inline-math ranges.
const mathRangeParser = unified()
  .use(remarkParse)
  .use(remarkMath)
  .freeze();

function availableMarker(source: string): string | undefined {
  for (let code = 0xfdd0; code <= 0xfdef; code += 1) {
    const marker = String.fromCharCode(code);
    if (!source.includes(marker)) return marker;
  }
  return undefined;
}

function inlineMathPipeOffsets(source: string): number[] {
  let tree: MarkdownNode;
  try {
    tree = mathRangeParser.parse(source) as MarkdownNode;
  } catch {
    return [];
  }
  const offsets: number[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "inlineMath") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isInteger(start) && Number.isInteger(end)) {
        for (let offset = start as number; offset < (end as number); offset += 1) {
          if (source[offset] === "|") offsets.push(offset);
        }
      }
    }
    for (const child of node.children || []) visit(child);
  };
  visit(tree);
  return offsets;
}

/**
 * Hide every pipe inside parser-confirmed inline math until GFM has fixed the
 * table cell boundaries. The one-code-unit replacement preserves source maps.
 */
export function prepareMarkdownMathPipes(source: string): PreparedMarkdownMathPipes {
  const firstDollar = source.indexOf("$");
  const lastDollar = source.lastIndexOf("$");
  const potentialPipe = source.indexOf("|", firstDollar + 1);
  if (
    firstDollar < 0
    || firstDollar === lastDollar
    || potentialPipe < 0
    || potentialPipe > lastDollar
  ) return { markdown: source };
  const offsets = inlineMathPipeOffsets(source);
  if (!offsets.length) return { markdown: source };
  const tableMathPipeMarker = availableMarker(source);
  if (!tableMathPipeMarker) return { markdown: source };
  const characters = source.split("");
  for (const offset of offsets) characters[offset] = tableMathPipeMarker;
  return { markdown: characters.join(""), tableMathPipeMarker };
}

/** Restore one render's collision-free marker before HAST and KaTeX. */
export function remarkRestoreMarkdownMathPipes(options: { marker: string }) {
  const marker = options.marker;
  return (tree: MarkdownNode) => {
    const seen = new WeakSet<object>();
    const restore = (value: unknown): void => {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      const record = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(record)) {
        if (typeof child === "string" && child.includes(marker))
          record[key] = child.split(marker).join("|");
        else restore(child);
      }
    };
    // GFM can reinterpret a protected range as link metadata, so restore every
    // string field in the per-render mdast, including url and data.hChildren.
    restore(tree);
  };
}
