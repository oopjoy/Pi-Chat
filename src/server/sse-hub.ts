import type { ServerResponse } from "node:http";

const MAX_SSE_EVENT_BYTES = 512 * 1024;
// A slow local browser must not grow server memory without bound. Normal Pi
// traffic stays far below this because only adjacent cumulative snapshots merge.
const MAX_PENDING_SSE_BYTES = 2 * 1024 * 1024;
// The browser already paints cumulative assistant snapshots at this cadence.
// Sending faster frames only multiplies JSON parsing/EventSource work across
// parallel Sessions and makes Chromium deliver an accumulated burst after a
// short main-thread stall.
const DEFAULT_SNAPSHOT_INTERVAL_MS = 50;

function eventFrame(event: Record<string, unknown>): string {
  const data = JSON.stringify(event);
  const bytes = Buffer.byteLength(data);
  if (bytes <= MAX_SSE_EVENT_BYTES) return `event: pi\ndata: ${data}\n\n`;
  return `event: pi\ndata: ${JSON.stringify({
    type: "pi_chat_oversized_event",
    originalType: String(event.type || "unknown"),
    piChatSessionId: typeof event.piChatSessionId === "string" ? event.piChatSessionId : undefined,
    bytes,
  })}\n\n`;
}

interface PendingFrame {
  frame: string;
  /** Cumulative assistant snapshots may replace only an immediately previous snapshot. */
  snapshotKey?: string;
}

interface PendingFrames {
  frames: PendingFrame[];
  bytes: number;
}

interface ScheduledSnapshot {
  event: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
}

export type SseDisconnectReason = "request-close" | "write-error" | "pending-buffer-limit" | "shutdown";
export interface SseDisconnectInfo {
  reason: SseDisconnectReason;
  pendingBytes?: number;
}

/**
 * Owns SSE client sockets and fan-out only.
 *
 * `ServerResponse.write() === false` means Node accepted the frame but asks us
 * to wait before writing another one. It must not be treated as a rejected
 * frame: doing so lets a later JSONL refresh place a tool result ahead of the
 * assistant snapshot that introduced its tool call.
 */
export class SseHub {
  private readonly clients = new Map<ServerResponse, string>();
  private readonly backpressured = new Set<ServerResponse>();
  private readonly pendingFrames = new Map<ServerResponse, PendingFrames>();
  private readonly scheduledSnapshots = new Map<ServerResponse, Map<string, ScheduledSnapshot>>();
  private readonly lastSnapshotWrites = new Map<ServerResponse, Map<string, number>>();
  private readonly disconnectListeners = new Set<(response: ServerResponse, clientId: string, info: SseDisconnectInfo) => void>();

  constructor(private readonly snapshotIntervalMs = DEFAULT_SNAPSHOT_INTERVAL_MS) {}

  get size(): number {
    return this.clients.size;
  }

  /** Same Map instance exposed for dual-session tests that inject write stubs. */
  get clientMap(): Map<ServerResponse, string> {
    return this.clients;
  }

  add(response: ServerResponse, clientId: string): void {
    this.clients.set(response, clientId);
  }

  remove(response: ServerResponse): string {
    return this.disconnect(response, { reason: "request-close" });
  }

  /** Report a transport-only departure without conflating it with app lifecycle. */
  disconnect(response: ServerResponse, info: SseDisconnectInfo): string {
    const clientId = this.clients.get(response) || "";
    if (!this.clients.delete(response)) return "";
    this.backpressured.delete(response);
    this.pendingFrames.delete(response);
    const scheduled = this.scheduledSnapshots.get(response);
    if (scheduled) for (const snapshot of scheduled.values()) clearTimeout(snapshot.timer);
    this.scheduledSnapshots.delete(response);
    this.lastSnapshotWrites.delete(response);
    for (const listener of this.disconnectListeners) listener(response, clientId, info);
    return clientId;
  }

  onDisconnect(listener: (response: ServerResponse, clientId: string, info: SseDisconnectInfo) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  has(response: ServerResponse): boolean {
    return this.clients.has(response);
  }

  broadcast(event: Record<string, unknown>): void {
    if (!this.clients.size) return;
    const type = String(event.type || "");
    const sessionKey = String(event.piChatSessionId || "primary");
    if (type === "message_update") {
      // Delay JSON serialization along with delivery. Pi snapshots contain the
      // whole assistant message, so serializing every discarded intermediate
      // frame creates quadratic work during long parallel responses.
      for (const client of this.clients.keys()) this.writeSnapshot(client, event, sessionKey);
      return;
    }
    const snapshotKey = type === "message_start" ? sessionKey : undefined;
    const frame = eventFrame(event);
    for (const client of this.clients.keys()) {
      // A terminal/tool/lifecycle frame must never overtake a throttled
      // cumulative snapshot from the same Session.
      this.flushScheduledSnapshot(client, sessionKey);
      if (this.clients.has(client)) this.write(client, frame, snapshotKey);
    }
  }

  heartbeat(response: ServerResponse, at = Date.now()): void {
    if (!this.clients.has(response)) return;
    this.write(response, eventFrame({ type: "pi_chat_heartbeat", at }));
  }

  /**
   * Per-connection frames (e.g. control ownership looks different per window).
   * Builder may return null to skip a client.
   */
  broadcastEach(build: (clientId: string) => Record<string, unknown> | null): void {
    for (const [client, clientId] of this.clients) {
      const event = build(clientId);
      if (!event) continue;
      this.write(client, eventFrame(event));
    }
  }

  closeAll(): void {
    for (const client of this.clients.keys()) {
      this.disconnect(client, { reason: "shutdown" });
      try {
        client.end();
      } catch {
        // Shutdown path must not throw.
      }
    }
    this.backpressured.clear();
    this.pendingFrames.clear();
    this.scheduledSnapshots.clear();
    this.lastSnapshotWrites.clear();
  }

  private writeSnapshot(client: ServerResponse, event: Record<string, unknown>, snapshotKey: string): void {
    // Once Node reports socket pressure, retain the existing immediate enqueue
    // path: enqueue() already coalesces adjacent cumulative snapshots and its
    // drain ordering is covered independently.
    if (this.backpressured.has(client) || this.snapshotIntervalMs <= 0) {
      this.markSnapshotWritten(client, snapshotKey);
      this.write(client, eventFrame(event), snapshotKey);
      return;
    }
    const lastWrite = this.lastSnapshotWrites.get(client)?.get(snapshotKey) || 0;
    const elapsed = Date.now() - lastWrite;
    const pendingBySession = this.scheduledSnapshots.get(client) || new Map<string, ScheduledSnapshot>();
    const pending = pendingBySession.get(snapshotKey);
    if (!pending && elapsed >= this.snapshotIntervalMs) {
      this.markSnapshotWritten(client, snapshotKey);
      this.write(client, eventFrame(event), snapshotKey);
      return;
    }
    if (pending) {
      pending.event = event;
      return;
    }
    const delay = Math.max(0, this.snapshotIntervalMs - elapsed);
    const timer = setTimeout(() => this.flushScheduledSnapshot(client, snapshotKey), delay);
    pendingBySession.set(snapshotKey, { event, timer });
    this.scheduledSnapshots.set(client, pendingBySession);
  }

  private flushScheduledSnapshot(client: ServerResponse, snapshotKey: string): void {
    const pendingBySession = this.scheduledSnapshots.get(client);
    const pending = pendingBySession?.get(snapshotKey);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingBySession?.delete(snapshotKey);
    if (pendingBySession && !pendingBySession.size) this.scheduledSnapshots.delete(client);
    if (!this.clients.has(client)) return;
    this.markSnapshotWritten(client, snapshotKey);
    this.write(client, eventFrame(pending.event), snapshotKey);
  }

  private markSnapshotWritten(client: ServerResponse, snapshotKey: string): void {
    const writes = this.lastSnapshotWrites.get(client) || new Map<string, number>();
    writes.set(snapshotKey, Date.now());
    this.lastSnapshotWrites.set(client, writes);
  }

  private write(client: ServerResponse, frame: string, snapshotKey?: string): void {
    if (this.backpressured.has(client)) {
      this.enqueue(client, frame, snapshotKey);
      return;
    }
    try {
      if (client.write(frame) !== false) return;
      this.backpressured.add(client);
      this.waitForDrain(client);
    } catch {
      this.disconnect(client, { reason: "write-error" });
    }
  }

  private enqueue(client: ServerResponse, frame: string, snapshotKey?: string): void {
    const pending = this.pendingFrames.get(client) || { frames: [], bytes: 0 };
    const previous = pending.frames.at(-1);
    // Pi assistant events are cumulative snapshots. Coalescing only adjacent
    // snapshots retains order around tool/terminal/session events.
    if (snapshotKey && previous?.snapshotKey === snapshotKey) {
      pending.bytes -= Buffer.byteLength(previous.frame);
      previous.frame = frame;
    } else pending.frames.push({ frame, snapshotKey });
    pending.bytes += Buffer.byteLength(frame);
    if (pending.bytes > MAX_PENDING_SSE_BYTES) {
      // A reconnect makes the browser fetch an authoritative view. Disconnecting
      // is safer than silently dropping ordered lifecycle/tool terminal events.
      this.disconnect(client, { reason: "pending-buffer-limit", pendingBytes: pending.bytes });
      try { client.end(); } catch { /* socket is already unusable */ }
      return;
    }
    this.pendingFrames.set(client, pending);
  }

  private waitForDrain(client: ServerResponse): void {
    client.once("drain", () => this.flush(client));
  }

  private flush(client: ServerResponse): void {
    if (!this.clients.has(client)) return;
    this.backpressured.delete(client);
    const pending = this.pendingFrames.get(client);
    while (pending?.frames.length) {
      const next = pending.frames.shift();
      if (!next) break;
      pending.bytes -= Buffer.byteLength(next.frame);
      if (!pending.frames.length) this.pendingFrames.delete(client);
      try {
        if (client.write(next.frame) !== false) continue;
        this.backpressured.add(client);
        this.waitForDrain(client);
        return;
      } catch {
        this.disconnect(client, { reason: "write-error" });
        return;
      }
    }
  }
}
