export interface StreamingMarkdownSegments {
  /** Completed Markdown regions whose source no longer changes during append-only streaming. */
  stable: string[];
  /** The currently growing region; only this region needs repeated Markdown parsing. */
  tail: string;
}

export interface StreamingMarkdownAppendHint {
  sequence: number;
  append: string;
}

export interface StreamingMarkdownState extends StreamingMarkdownSegments {
  /** Normalized cumulative source represented by stable + tail. */
  source: string;
  /** Last trusted browser-local append sequence applied to this block. */
  sequence?: number;
  /** Characters inspected by the most recent incremental step. */
  scannedCharacters: number;
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

/**
 * Advance an append-only streaming projection by rescanning only its mutable
 * tail plus the newly appended suffix. Provider corrections, truncation, and
 * line-ending rewrites deliberately fall back to the canonical full scan.
 * Terminal rendering remains a separate whole-document Markdown pass.
 */
export function advanceStreamingMarkdown(
  previous: StreamingMarkdownState | undefined,
  source: string,
  appendHint?: StreamingMarkdownAppendHint,
): StreamingMarkdownState {
  const normalized = source.replace(/\r\n?/g, "\n");
  const normalizedAppend = appendHint?.append.replace(/\r\n?/g, "\n");
  const trustedAppend = Boolean(
    previous
    && appendHint
    && (previous.sequence === undefined || appendHint.sequence > previous.sequence)
    && normalizedAppend !== undefined
    && normalized.length === previous.source.length + normalizedAppend.length
    && normalized.endsWith(normalizedAppend),
  );
  if (previous && trustedAppend) {
    const mutableSource = previous.tail + normalizedAppend;
    const advanced = streamingMarkdownSegments(mutableSource);
    return {
      source: normalized,
      sequence: appendHint?.sequence,
      stable: [...previous.stable, ...advanced.stable],
      tail: advanced.tail,
      scannedCharacters: mutableSource.length,
    };
  }
  if (!previous || !normalized.startsWith(previous.source)) {
    const segments = streamingMarkdownSegments(normalized);
    return {
      source: normalized,
      ...(appendHint ? { sequence: appendHint.sequence } : null),
      ...segments,
      scannedCharacters: normalized.length,
    };
  }
  if (normalized === previous.source) return previous;

  const suffix = normalized.slice(previous.source.length);
  const mutableSource = previous.tail + suffix;
  const advanced = streamingMarkdownSegments(mutableSource);
  const sequence = appendHint && (previous.sequence === undefined || appendHint.sequence > previous.sequence)
    ? appendHint.sequence
    : previous.sequence;
  return {
    source: normalized,
    ...(sequence !== undefined ? { sequence } : null),
    stable: [...previous.stable, ...advanced.stable],
    tail: advanced.tail,
    scannedCharacters: mutableSource.length,
  };
}
