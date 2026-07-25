import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { rehypeSourceRanges } from "./markdown-source-copy";

type MarkdownPosition = { start?: { offset?: number }; end?: { offset?: number } };
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; position?: MarkdownPosition };

/**
 * CommonMark intentionally rejects some adjacent delimiter runs; notably,
 * `**理由：**在…` becomes literal text when the bold content ends in Chinese
 * punctuation and is immediately followed by CJK text. Pi's prose routinely
 * uses that natural form. Recover only the unambiguous `**text**word` form at
 * the AST stage, after math/code have already become their own nodes.
 */
export function remarkAdjacentStrongBoundary() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode): void => {
      if (!node.children) return;
      const children: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) {
          visit(child);
          children.push(child);
          continue;
        }
        const pattern = /(?<!\\)\*\*([^*\r\n]+?)\*\*(?=[\p{L}\p{N}_])/gu;
        const base = child.position?.start?.offset;
        let cursor = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(child.value))) {
          const start = match.index;
          const end = start + match[0].length;
          if (start > cursor) children.push({
            type: "text", value: child.value.slice(cursor, start),
            ...(typeof base === "number" ? { position: { start: { offset: base + cursor }, end: { offset: base + start } } } : {}),
          });
          children.push({
            type: "strong",
            children: [{
              type: "text", value: match[1],
              ...(typeof base === "number" ? { position: { start: { offset: base + start + 2 }, end: { offset: base + end - 2 } } } : {}),
            }],
            ...(typeof base === "number" ? { position: { start: { offset: base + start }, end: { offset: base + end } } } : {}),
          });
          cursor = end;
        }
        if (cursor === 0) {
          children.push(child);
        } else if (cursor < child.value.length) {
          children.push({
            type: "text", value: child.value.slice(cursor),
            ...(typeof base === "number" ? { position: { start: { offset: base + cursor }, end: child.position?.end } } : {}),
          });
        }
      }
      node.children = children;
    };
    visit(tree);
  };
}

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

export const markdownRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [remarkGfm, remarkMath, remarkAdjacentStrongBoundary];

const katexOptions = { throwOnError: false, strict: false as const };

/** Streaming skips source-range mapping; final render attaches exact copy offsets. */
export function createMarkdownRehypePlugins(mapOffset?: (offset: number) => number): ReactMarkdownOptions["rehypePlugins"] {
  return [
    rehypeRaw,
    [rehypeSanitize, markdownSanitizeSchema],
    ...(mapOffset ? [[rehypeSourceRanges, { mapOffset }] as const] : []),
    [rehypeKatex, katexOptions],
  ] as ReactMarkdownOptions["rehypePlugins"];
}
