type SourcePoint = { offset?: number };
type SourcePosition = { start?: SourcePoint; end?: SourcePoint };
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: SourcePosition;
};

export interface SourceMappedMarkdown {
  markdown: string;
  source: string;
  mapOffset: (offset: number) => number;
}

function identityOffset(offset: number): number {
  return offset;
}

/**
 * remark-math requires display delimiters on their own lines. Keep Pi-web's
 * one-line display-math compatibility while retaining a boundary map back to
 * the exact Markdown supplied by the model.
 */
export function normalizeDisplayMathWithSourceMap(source: string): SourceMappedMarkdown {
  const lineBreak = source.includes("\r\n") ? "\r\n" : "\n";
  const linePattern = /.*(?:\r\n|\n|$)/g;
  const output: string[] = [];
  const boundaries: number[] = [0];
  let changed = false;

  const appendOriginal = (text: string, sourceStart: number) => {
    output.push(text);
    for (let index = 1; index <= text.length; index += 1) boundaries.push(sourceStart + index);
  };
  const appendInserted = (text: string, sourceOffset: number) => {
    output.push(text);
    for (let index = 0; index < text.length; index += 1) boundaries.push(sourceOffset);
  };

  let fence: { marker: string; size: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(source)) && match[0]) {
    const wholeLine = match[0];
    const eolMatch = wholeLine.match(/\r\n$|\n$/);
    const eol = eolMatch?.[0] ?? "";
    const line = eol ? wholeLine.slice(0, -eol.length) : wholeLine;
    const sourceStart = match.index;
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const size = fenceMatch[1].length;
      if (!fence) fence = { marker, size };
      else if (marker === fence.marker && size >= fence.size) fence = null;
      appendOriginal(wholeLine, sourceStart);
      continue;
    }

    const display = !fence ? line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/) : null;
    if (!display || !display[2].trim()) {
      appendOriginal(wholeLine, sourceStart);
      continue;
    }

    changed = true;
    const indent = display[1];
    const math = display[2].trim();
    const mathStartInLine = line.indexOf(math, indent.length + 2);
    const mathStart = sourceStart + mathStartInLine;
    const closeStart = sourceStart + line.lastIndexOf("$$");

    appendOriginal(line.slice(0, indent.length + 2), sourceStart);
    appendInserted(lineBreak, mathStart);
    appendOriginal(math, mathStart);
    appendInserted(lineBreak + indent, closeStart);
    appendOriginal("$$", closeStart);
    boundaries[boundaries.length - 1] = sourceStart + line.length;
    if (eol) appendOriginal(eol, sourceStart + line.length);
  }

  if (!changed) return { markdown: source, source, mapOffset: identityOffset };
  const markdown = output.join("");
  return {
    markdown,
    source,
    mapOffset(offset: number) {
      const safeOffset = Math.max(0, Math.min(offset, boundaries.length - 1));
      return boundaries[safeOffset] ?? source.length;
    },
  };
}

const atomicTags = new Set([
  "a", "img", "strong", "em", "del", "code", "blockquote", "ul", "ol",
  "table", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
]);

function sourceOffsets(node: HastNode, mapOffset: (offset: number) => number) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  return { start: mapOffset(start as number), end: mapOffset(end as number) };
}

function sourceProperties(start: number, end: number, atomic: boolean, className: unknown = []) {
  const classes = Array.isArray(className) ? className.map(String) : [];
  return {
    className: [...classes, "source-fragment"],
    dataSourceStart: start,
    dataSourceEnd: end,
    ...(atomic ? { dataSourceAtomic: "true" } : {}),
  };
}

function isMathElement(node: HastNode): { isMath: boolean; display: boolean } {
  const className = node.properties?.className;
  const classes = Array.isArray(className) ? className.map(String) : [];
  const inline = classes.includes("math-inline");
  return {
    isMath: inline || classes.includes("math-display") || classes.includes("language-math"),
    display: classes.includes("math-display") || (classes.includes("language-math") && !inline),
  };
}

function sourceWrapper(node: HastNode, start: number, end: number, atomic: boolean, block: boolean): HastNode {
  return {
    type: "element",
    tagName: block ? "div" : "span",
    properties: sourceProperties(start, end, atomic),
    children: [node],
    position: node.position,
  };
}

function annotateChildren(parent: HastNode, mapOffset: (offset: number) => number): void {
  if (!parent.children) return;
  const nextChildren: HastNode[] = [];

  for (const child of parent.children) {
    const offsets = sourceOffsets(child, mapOffset);
    if (child.type === "text") {
      nextChildren.push(offsets ? sourceWrapper(child, offsets.start, offsets.end, false, false) : child);
      continue;
    }
    if (child.type !== "element") {
      nextChildren.push(child);
      continue;
    }

    const math = isMathElement(child);
    const tagName = child.tagName || "";
    const atomic = math.isMath || atomicTags.has(tagName) || tagName === "pre";
    const structural = ["blockquote", "ul", "ol", "table"].includes(tagName);
    if (!atomic || structural) annotateChildren(child, mapOffset);

    if (offsets && math.isMath) {
      nextChildren.push(sourceWrapper(child, offsets.start, offsets.end, true, math.display));
      continue;
    }
    if (offsets && tagName === "pre") {
      nextChildren.push(sourceWrapper(child, offsets.start, offsets.end, true, true));
      continue;
    }
    if (offsets && atomic) {
      child.properties = {
        ...(child.properties || {}),
        ...sourceProperties(offsets.start, offsets.end, true, child.properties?.className),
      };
    }
    nextChildren.push(child);
  }

  parent.children = nextChildren;
}

/** Add source ranges before rehype-katex replaces formula nodes with KaTeX DOM. */
export function rehypeSourceRanges(options: { mapOffset?: (offset: number) => number } = {}) {
  const mapOffset = options.mapOffset ?? identityOffset;
  return (tree: HastNode) => annotateChildren(tree, mapOffset);
}

function nodeInside(element: Element, node: Node | null): boolean {
  if (!node) return false;
  const parent = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return parent === element || Boolean(parent && element.contains(parent));
}

function pointInside(element: Element, node: Node, offset: number): boolean {
  if (!nodeInside(element, node)) return false;
  if (node !== element) return true;
  return offset > 0 && offset < element.childNodes.length;
}

function sourceNumber(element: HTMLElement, name: "sourceStart" | "sourceEnd"): number | null {
  const value = Number.parseInt(element.dataset[name] || "", 10);
  return Number.isInteger(value) ? value : null;
}

function markdownEscapeAt(raw: string, index: number): boolean {
  return raw[index] === "\\" && index + 1 < raw.length
    && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(raw[index + 1]);
}

function decodeEntity(raw: string): string {
  const decoder = document.createElement("textarea");
  decoder.innerHTML = raw;
  return decoder.value;
}

function entityAt(raw: string, index: number): { rawLength: number; text: string } | null {
  const match = /^&(?:#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/i.exec(raw.slice(index));
  return match ? { rawLength: match[0].length, text: decodeEntity(match[0]) } : null;
}

/** Map a character boundary in rendered plain text back into its Markdown token. */
function rawOffsetForVisibleOffset(raw: string, visible: string, offset: number): number | null {
  if (raw === visible) return Math.min(offset, raw.length);
  const positions = [0];
  let rawIndex = 0;
  let visibleIndex = 0;
  while (rawIndex < raw.length && visibleIndex < visible.length) {
    let emitted: string;
    let width = 1;
    if (markdownEscapeAt(raw, rawIndex)) {
      emitted = raw[rawIndex + 1];
      width = 2;
    } else {
      const entity = raw[rawIndex] === "&" ? entityAt(raw, rawIndex) : null;
      if (entity) {
        emitted = entity.text;
        width = entity.rawLength;
      } else {
        emitted = raw[rawIndex];
      }
    }
    if (!visible.startsWith(emitted, visibleIndex)) return null;
    rawIndex += width;
    for (let index = 0; index < emitted.length; index += 1) {
      visibleIndex += 1;
      positions[visibleIndex] = rawIndex;
    }
  }
  return positions[Math.min(offset, positions.length - 1)] ?? null;
}

function sourceBoundaryForPoint(fragment: HTMLElement, source: string, node: Node, offset: number, isStart: boolean): number | null {
  const start = sourceNumber(fragment, "sourceStart");
  const end = sourceNumber(fragment, "sourceEnd");
  if (start === null || end === null) return null;
  if (fragment.dataset.sourceAtomic === "true" || !pointInside(fragment, node, offset)) {
    return isStart ? start : end;
  }

  const before = document.createRange();
  try {
    before.setStart(fragment, 0);
    before.setEnd(node, offset);
  } catch {
    return isStart ? start : end;
  }
  const raw = source.slice(start, end);
  const mapped = rawOffsetForVisibleOffset(raw, fragment.textContent || "", before.toString().length);
  return mapped === null ? (isStart ? start : end) : start + mapped;
}

function endpointSourceFragment(content: HTMLElement, node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  if (!element || !content.contains(element)) return null;
  const atomic = element.closest<HTMLElement>('[data-source-atomic="true"][data-source-start][data-source-end]');
  if (atomic && content.contains(atomic)) return atomic;
  const fragment = element.closest<HTMLElement>("[data-source-start][data-source-end]");
  return fragment && content.contains(fragment) ? fragment : null;
}

/** Return the exact Markdown/LaTeX represented by a rendered browser selection. */
export function sourceForSelection(content: HTMLElement, selection: Selection | null, source: string): string | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const selectedRange = selection.getRangeAt(0);
  const clipped = document.createRange();
  const startsHere = nodeInside(content, selectedRange.startContainer);
  const endsHere = nodeInside(content, selectedRange.endContainer);
  try {
    if (startsHere) clipped.setStart(selectedRange.startContainer, selectedRange.startOffset);
    else clipped.setStart(content, 0);
    if (endsHere) clipped.setEnd(selectedRange.endContainer, selectedRange.endOffset);
    else clipped.setEnd(content, content.childNodes.length);
  } catch {
    return null;
  }
  if (clipped.collapsed) return null;

  const fragments = [...content.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")]
    .filter((fragment) => {
      try { return clipped.intersectsNode(fragment); } catch { return false; }
    });
  if (!fragments.length) return null;

  const first = endpointSourceFragment(content, clipped.startContainer) || fragments[0];
  const last = endpointSourceFragment(content, clipped.endContainer) || fragments[fragments.length - 1];
  let start = sourceBoundaryForPoint(first, source, clipped.startContainer, clipped.startOffset, true);
  let end = sourceBoundaryForPoint(last, source, clipped.endContainer, clipped.endOffset, false);
  if (start === null || end === null) return null;
  if (end < start) [start, end] = [end, start];
  return source.slice(start, end) || null;
}

type SourceCopyRegistration = { source: string; onCopied?: () => void };
const sourceCopyRoots = new Map<HTMLElement, SourceCopyRegistration>();
let documentCopyListener: ((event: globalThis.ClipboardEvent) => void) | null = null;

function compareDocumentOrder(left: HTMLElement, right: HTMLElement): number {
  if (left === right) return 0;
  return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

function installDocumentCopyListener(): void {
  if (documentCopyListener || typeof document === "undefined") return;
  documentCopyListener = (event) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !event.clipboardData) return;
    const selectedRange = selection.getRangeAt(0);
    const roots = [...sourceCopyRoots.keys()]
      .filter((root) => {
        try { return selectedRange.intersectsNode(root); } catch { return false; }
      })
      .sort(compareDocumentOrder);
    const parts = roots
      .map((root) => ({ root, source: sourceForSelection(root, selection, sourceCopyRoots.get(root)?.source || "") }))
      .filter((part): part is { root: HTMLElement; source: string } => Boolean(part.source));
    if (!parts.length) return;

    const source = parts.map((part) => part.source).join("\n\n");
    event.clipboardData.setData("text/plain", source);
    event.clipboardData.setData("text/markdown", source);
    event.preventDefault();
    for (const part of parts) sourceCopyRoots.get(part.root)?.onCopied?.();
  };
  document.addEventListener("copy", documentCopyListener);
}

/** Register a rendered Markdown root with the shared multi-block copy handler. */
export function registerSourceCopyRoot(root: HTMLElement, registration: SourceCopyRegistration): () => void {
  sourceCopyRoots.set(root, registration);
  installDocumentCopyListener();
  return () => {
    sourceCopyRoots.delete(root);
    if (!sourceCopyRoots.size && documentCopyListener) {
      document.removeEventListener("copy", documentCopyListener);
      documentCopyListener = null;
    }
  };
}
