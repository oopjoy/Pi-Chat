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

/**
 * Only real Markdown links can grant authority, never images/code/definitions
 * alone. Image destinations get their own render-only authority through
 * markdownImageDestinations; they must never unlock opening files.
 */
export function markdownLinkDestinations(source: string): string[] {
  if (!source.includes("[")) return [];
  return markdownDestinations(source, new Set(["link", "linkReference"]));
}

/** Render-only destinations from Markdown images in persisted assistant text. */
export function markdownImageDestinations(source: string): string[] {
  if (!source.includes("![")) return [];
  return markdownDestinations(source, new Set(["image", "imageReference"]));
}

function markdownDestinations(source: string, wanted: Set<string>): string[] {
  const root = parser.parse(source) as LinkNode;
  const definitions = new Map<string, string>();
  const matches: LinkNode[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    // Raw HTML has separate rendering/sanitization semantics. Fail closed for
    // mixed-HTML blocks rather than authorizing links hidden inside an element
    // (e.g. script) which the browser's sanitizer removes.
    if (node.type === "html") return [];
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
    if (wanted.has(node.type)) matches.push(node);
    if (node.children) pending.push(...node.children.slice().reverse());
  }
  return matches.flatMap((node) => {
    const url = node.type.endsWith("Reference") ? definitions.get(node.identifier || "") : node.url;
    return url ? [url] : [];
  });
}
