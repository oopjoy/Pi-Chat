import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { rehypeSourceRanges } from "./markdown-source-copy";

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

export const markdownRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [remarkGfm, remarkMath];

export function createMarkdownRehypePlugins(mapOffset: (offset: number) => number): ReactMarkdownOptions["rehypePlugins"] {
  return [
    rehypeRaw,
    [rehypeSanitize, markdownSanitizeSchema],
    [rehypeSourceRanges, { mapOffset }],
    [rehypeKatex, { throwOnError: false, strict: false }],
  ] as ReactMarkdownOptions["rehypePlugins"];
}
