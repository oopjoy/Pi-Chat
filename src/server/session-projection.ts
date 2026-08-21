import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

const READ_CHUNK_BYTES = 256 * 1024;
const FINGERPRINT_WINDOW_BYTES = 64 * 1024;
const MAX_JSONL_ENTRY_BYTES = 65 * 1024 * 1024;

export type SessionProjectionKind = "none" | "append" | "rewrite";

export interface SessionProjectionReadEvent {
  kind: Exclude<SessionProjectionKind, "none">;
  offset: number;
  bytes: number;
}

export interface SessionProjectionOptions<Entry> {
  retain(value: Record<string, unknown>): Entry | null;
  observeRead?(event: SessionProjectionReadEvent): void;
}

export interface SessionProjectionResult<Entry> {
  kind: SessionProjectionKind;
  entries: readonly Entry[];
  committedBytes: number;
  observedBytes: number;
  uncommittedBytes: number;
  sourceIdentity: string;
  prefixFingerprint: string;
  bytesRead: number;
}

interface DecodedSuffix<Entry> {
  committedEntries: Entry[];
  provisionalEntry: Entry | null;
  committedBytes: number;
  bytesRead: number;
}

function sourceIdentity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

function sameVersion(left: Stats, right: Stats): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && sourceIdentity(left) === sourceIdentity(right);
}

function parseEntry<Entry>(
  line: Buffer,
  retain: SessionProjectionOptions<Entry>["retain"],
): Entry | null {
  if (!line.length) return null;
  try {
    const value = JSON.parse(line.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return retain(value as Record<string, unknown>);
  } catch {
    // Preserve Pi Chat's existing tolerance for malformed or partially-written
    // JSONL records. A newline-terminated malformed record is skipped; an EOF
    // tail remains provisional and is re-read on the next reconciliation.
    return null;
  }
}

async function readExact(
  handle: FileHandle,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const output = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(output, read, length - read, offset + read);
    if (!result.bytesRead) throw new Error("Session JSONL changed while its prefix was verified");
    read += result.bytesRead;
  }
  return output;
}

async function committedFingerprint(
  handle: FileHandle,
  committedBytes: number,
): Promise<{ value: string; bytesRead: number }> {
  const firstLength = Math.min(committedBytes, FINGERPRINT_WINDOW_BYTES);
  const tailStart = Math.max(firstLength, committedBytes - FINGERPRINT_WINDOW_BYTES);
  const tailLength = Math.max(0, committedBytes - tailStart);
  const first = await readExact(handle, 0, firstLength);
  const tail = await readExact(handle, tailStart, tailLength);
  const hash = createHash("sha256");
  hash.update(String(committedBytes));
  hash.update("\0");
  hash.update(first);
  hash.update("\0");
  hash.update(String(tailStart));
  hash.update("\0");
  hash.update(tail);
  return { value: hash.digest("hex"), bytesRead: first.length + tail.length };
}

async function decodeRange<Entry>(
  handle: FileHandle,
  start: number,
  end: number,
  kind: Exclude<SessionProjectionKind, "none">,
  options: SessionProjectionOptions<Entry>,
): Promise<DecodedSuffix<Entry>> {
  const committedEntries: Entry[] = [];
  let provisionalEntry: Entry | null = null;
  let committedBytes = start;
  let position = start;
  let pendingParts: Buffer[] = [];
  let pendingBytes = 0;
  let bytesRead = 0;
  while (position < end) {
    const requested = Math.min(READ_CHUNK_BYTES, end - position);
    const chunk = Buffer.allocUnsafe(requested);
    const result = await handle.read(chunk, 0, requested, position);
    if (!result.bytesRead) break;
    const value = chunk.subarray(0, result.bytesRead);
    options.observeRead?.({ kind, offset: position, bytes: result.bytesRead });
    position += result.bytesRead;
    bytesRead += result.bytesRead;
    let chunkOffset = 0;
    while (chunkOffset < value.length) {
      const newline = value.indexOf(0x0a, chunkOffset);
      if (newline < 0) {
        const remainder = value.subarray(chunkOffset);
        pendingParts.push(remainder);
        pendingBytes += remainder.length;
        if (pendingBytes > MAX_JSONL_ENTRY_BYTES)
          throw new Error(`Session JSONL entry exceeds ${MAX_JSONL_ENTRY_BYTES} bytes`);
        break;
      }
      const segment = value.subarray(chunkOffset, newline);
      const lineBytes = pendingBytes + segment.length;
      if (lineBytes > MAX_JSONL_ENTRY_BYTES)
        throw new Error(`Session JSONL entry exceeds ${MAX_JSONL_ENTRY_BYTES} bytes`);
      const line = pendingParts.length
        ? Buffer.concat([...pendingParts, segment], lineBytes)
        : segment;
      const retained = parseEntry(line, options.retain);
      if (retained) committedEntries.push(retained);
      committedBytes += lineBytes + 1;
      pendingParts = [];
      pendingBytes = 0;
      chunkOffset = newline + 1;
    }
  }
  // Historical and test JSONL files do not always end in LF. Project a valid
  // EOF object for compatibility, but do not advance committedBytes: the same
  // tail is re-read and either committed or replaced after the next append.
  if (pendingBytes) provisionalEntry = parseEntry(
    pendingParts.length === 1 ? pendingParts[0] : Buffer.concat(pendingParts, pendingBytes),
    options.retain,
  );
  return { committedEntries, provisionalEntry, committedBytes, bytesRead };
}

/**
 * Incremental physical projection of one Pi JSONL.
 *
 * Pi writes Sessions append-only. A stable file identity, monotonic size, and
 * bounded first/tail prefix fingerprint authorize suffix-only parsing. Any
 * truncation, replacement, same-size mutation, or fingerprint mismatch falls
 * back to a canonical full read. The caller owns semantic branch projection.
 */
export class SessionProjection<Entry> {
  readonly path: string;
  private committedEntries: Entry[] = [];
  private provisionalEntry: Entry | null = null;
  private committedBytes = 0;
  private observedBytes = 0;
  private identity = "";
  private version: Stats | null = null;
  private prefixFingerprint = "";

  constructor(path: string, private readonly options: SessionProjectionOptions<Entry>) {
    this.path = resolve(path);
  }

  get entries(): readonly Entry[] {
    return this.provisionalEntry
      ? [...this.committedEntries, this.provisionalEntry]
      : this.committedEntries;
  }

  get sourceBytes(): number {
    return this.observedBytes;
  }

  async reconcile(_expected?: Stats): Promise<SessionProjectionResult<Entry>> {
    const handle = await open(this.path, "r");
    try {
      const current = await handle.stat();
      // The open handle is authoritative if the caller's earlier inventory
      // stat raced an append, truncation, or atomic replacement.
      const targetBytes = current.size;
      if (this.version && sameVersion(this.version, current))
        return this.result("none", 0);

      let kind: Exclude<SessionProjectionKind, "none"> = "rewrite";
      let verificationBytes = 0;
      const appendCandidate = Boolean(
        this.version
        && this.identity === sourceIdentity(current)
        && targetBytes >= this.observedBytes
        && targetBytes >= this.committedBytes
        && targetBytes > this.observedBytes,
      );
      if (appendCandidate) {
        const verified = await committedFingerprint(handle, this.committedBytes);
        verificationBytes += verified.bytesRead;
        if (verified.value === this.prefixFingerprint) kind = "append";
      }

      if (kind === "append") {
        const decoded = await decodeRange(
          handle,
          this.committedBytes,
          targetBytes,
          "append",
          this.options,
        );
        this.committedEntries.push(...decoded.committedEntries);
        this.provisionalEntry = decoded.provisionalEntry;
        this.committedBytes = decoded.committedBytes;
        const fingerprint = await committedFingerprint(handle, this.committedBytes);
        verificationBytes += fingerprint.bytesRead;
        this.prefixFingerprint = fingerprint.value;
        this.observedBytes = targetBytes;
        this.identity = sourceIdentity(current);
        this.version = current;
        return this.result("append", decoded.bytesRead + verificationBytes);
      }

      const decoded = await decodeRange(handle, 0, targetBytes, "rewrite", this.options);
      this.committedEntries = decoded.committedEntries;
      this.provisionalEntry = decoded.provisionalEntry;
      this.committedBytes = decoded.committedBytes;
      const fingerprint = await committedFingerprint(handle, this.committedBytes);
      verificationBytes += fingerprint.bytesRead;
      this.prefixFingerprint = fingerprint.value;
      this.observedBytes = targetBytes;
      this.identity = sourceIdentity(current);
      this.version = current;
      return this.result("rewrite", decoded.bytesRead + verificationBytes);
    } finally {
      await handle.close();
    }
  }

  private result(kind: SessionProjectionKind, bytesRead: number): SessionProjectionResult<Entry> {
    return {
      kind,
      entries: this.entries,
      committedBytes: this.committedBytes,
      observedBytes: this.observedBytes,
      uncommittedBytes: Math.max(0, this.observedBytes - this.committedBytes),
      sourceIdentity: this.identity,
      prefixFingerprint: this.prefixFingerprint,
      bytesRead,
    };
  }
}
