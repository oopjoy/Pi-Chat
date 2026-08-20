export interface StreamingMarkdownSegments {
  /** Completed Markdown regions whose source no longer changes during append-only streaming. */
  stable: string[];
  /** The currently growing region; only this region needs repeated Markdown parsing. */
  tail: string;
}

const MAX_STREAMING_TAIL_CHARS = 8_192;

function fenceMarker(line: string): string | null {
  const trimmed = line.trimStart();
  const marker = trimmed.startsWith("```")
    ? trimmed.match(/^`{3,}/)?.[0]
    : trimmed.startsWith("~~~")
      ? trimmed.match(/^~{3,}/)?.[0]
      : undefined;
  return marker || null;
}

function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed[0] === marker[0]
    && trimmed.length >= marker.length
    && [...trimmed].every((character) => character === marker[0]);
}

function displayMathBoundary(line: string): boolean {
  return line.trim() === "$$";
}

/**
 * Split cumulative Markdown into immutable completed regions and one growing
 * tail. Stable regions are memoized by React, so GFM/KaTeX/sanitize run once
 * per completed region instead of across the full answer every 50 ms.
 *
 * Blank-line boundaries inside fenced code or display math stay inside the
 * active region. A very long no-blank paragraph is cut at a completed newline
 * to keep the repeatedly parsed tail bounded; terminal rendering still runs
 * the canonical whole-document pipeline.
 */
export function streamingMarkdownSegments(source: string): StreamingMarkdownSegments {
  const normalized = source.replace(/\r\n?/g, "\n");
  const stable: string[] = [];
  let segmentStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let displayMath = false;

  for (let cursor = 0; cursor <= normalized.length; cursor += 1) {
    if (cursor < normalized.length && normalized[cursor] !== "\n") {
      const safeInlineBoundary = !fence
        && !displayMath
        && cursor - segmentStart >= MAX_STREAMING_TAIL_CHARS
        && /\s/.test(normalized[cursor]);
      if (safeInlineBoundary) {
        stable.push(normalized.slice(segmentStart, cursor + 1));
        segmentStart = cursor + 1;
      }
      continue;
    }
    const line = normalized.slice(lineStart, cursor);
    const marker = fenceMarker(line);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else if (marker) {
      fence = marker;
    } else if (displayMathBoundary(line)) {
      displayMath = !displayMath;
    }

    const hasLineBreak = cursor < normalized.length;
    const nextLineStart = hasLineBreak ? cursor + 1 : cursor;
    const previousLineBreak = lineStart > 0 && normalized[lineStart - 1] === "\n";
    const blankBoundary = hasLineBreak
      && !fence
      && !displayMath
      && !line.trim()
      && previousLineBreak;
    const oversizedTail = hasLineBreak
      && !fence
      && !displayMath
      && nextLineStart - segmentStart >= MAX_STREAMING_TAIL_CHARS;
    if ((blankBoundary || oversizedTail) && nextLineStart > segmentStart) {
      stable.push(normalized.slice(segmentStart, nextLineStart));
      segmentStart = nextLineStart;
    }
    lineStart = nextLineStart;
  }

  return { stable, tail: normalized.slice(segmentStart) };
}
