import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

// Bundled into a standalone server module by build-server.mjs so the portable
// Windows artifact does not require node_modules at runtime.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
type LinkNode = {
  type: string;
  url?: string;
  identifier?: string;
  children?: LinkNode[];
};

/** Only real Markdown links can grant authority, never images/code/definitions alone. */
export function markdownLinkDestinations(source: string): string[] {
  if (!source.includes("[")) return [];
  const root = parser.parse(source) as LinkNode;
  const definitions = new Map<string, string>();
  const links: LinkNode[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    // Raw HTML has separate rendering/sanitization semantics. Fail closed for
    // mixed-HTML blocks rather than authorizing links hidden inside an element
    // (e.g. script) which the browser's sanitizer removes.
    if (node.type === "html") return [];
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
    if (node.type === "link" || node.type === "linkReference") links.push(node);
    if (node.children) pending.push(...node.children.slice().reverse());
  }
  return links.flatMap((node) => {
    const url = node.type === "link" ? node.url : definitions.get(node.identifier || "");
    return url ? [url] : [];
  });
}
