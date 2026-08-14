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

export type SseTransportOutcome =
  | "no-clients"
  | "scheduled"
  | "scheduled-replaced"
  | "oversized-substitute"
  | "written"
  | "written-backpressured"
  | "queued"
  | "queue-replaced"
  | "write-error"
  | "disconnected";

export interface SseTransportDiagnostic {
  outcome: SseTransportOutcome;
  eventType: string;
  originalEventType?: string;
  sessionId?: string;
  runGeneration?: number;
  size?: number;
  transportClients: number;
  controlledByThisWindow?: boolean;
  foreignOwnerPresent?: boolean;
  disconnectReason?: SseDisconnectReason;
  pendingBytes?: number;
}

interface FrameMetadata {
  eventType: string;
  originalEventType?: string;
  sessionId?: string;
  runGeneration?: number;
  size?: number;
  controlledByThisWindow?: boolean;
  foreignOwnerPresent?: boolean;
}

interface FramedEvent {
  frame: string;
  metadata: FrameMetadata;
}

function eventMetadata(event: Record<string, unknown>): FrameMetadata {
  return {
    eventType: typeof event.type === "string" ? event.type : "unknown",
    ...(typeof event.piChatSessionId === "string"
      ? { sessionId: event.piChatSessionId }
      : typeof event.sessionId === "string"
        ? { sessionId: event.sessionId }
        : null),
    ...(typeof event.piChatRunGeneration === "number" && Number.isFinite(event.piChatRunGeneration)
      ? { runGeneration: Math.max(0, Math.floor(event.piChatRunGeneration)) }
      : null),
    ...(typeof event.controlledByThisWindow === "boolean"
      ? { controlledByThisWindow: event.controlledByThisWindow }
      : null),
    ...(typeof event.controlOwner === "string"
      ? { foreignOwnerPresent: Boolean(event.controlOwner) && event.controlledByThisWindow !== true }
      : null),
  };
}

function eventFrame(event: Record<string, unknown>): FramedEvent {
  const original = eventMetadata(event);
  const data = JSON.stringify(event);
  const bytes = Buffer.byteLength(data);
  if (bytes <= MAX_SSE_EVENT_BYTES) {
    const frame = `event: pi\ndata: ${data}\n\n`;
    return { frame, metadata: { ...original, size: Buffer.byteLength(frame) } };
  }
  const frame = `event: pi\ndata: ${JSON.stringify({
    type: "pi_chat_oversized_event",
    originalType: original.eventType,
    piChatSessionId: original.sessionId,
    bytes,
  })}\n\n`;
  return {
    frame,
    metadata: {
      ...original,
      eventType: "pi_chat_oversized_event",
      originalEventType: original.eventType,
      size: Buffer.byteLength(frame),
    },
  };
}

interface PendingFrame {
  framed: FramedEvent;
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
  private diagnosticObserver?: (event: SseTransportDiagnostic) => void;

  constructor(
    private readonly snapshotIntervalMs = DEFAULT_SNAPSHOT_INTERVAL_MS,
    diagnosticObserver?: (event: SseTransportDiagnostic) => void,
  ) {
    this.diagnosticObserver = diagnosticObserver;
  }

  setDiagnosticObserver(observer?: (event: SseTransportDiagnostic) => void): void {
    this.diagnosticObserver = observer;
  }

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
    this.observe("disconnected", { eventType: "unknown" }, {
      disconnectReason: info.reason,
      ...(typeof info.pendingBytes === "number" ? { pendingBytes: info.pendingBytes } : null),
    });
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
    if (!this.clients.size) {
      this.observe("no-clients", eventMetadata(event));
      return;
    }
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
    const framed = eventFrame(event);
    if (framed.metadata.originalEventType)
      this.observe("oversized-substitute", framed.metadata);
    for (const client of this.clients.keys()) {
      // A terminal/tool/lifecycle frame must never overtake a throttled
      // cumulative snapshot from the same Session.
      this.flushScheduledSnapshot(client, sessionKey);
      if (this.clients.has(client)) this.write(client, framed, snapshotKey);
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
      const framed = eventFrame(event);
      if (framed.metadata.originalEventType)
        this.observe("oversized-substitute", framed.metadata);
      this.write(client, framed);
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
      const framed = eventFrame(event);
      if (framed.metadata.originalEventType)
        this.observe("oversized-substitute", framed.metadata);
      this.write(client, framed, snapshotKey);
      return;
    }
    const lastWrite = this.lastSnapshotWrites.get(client)?.get(snapshotKey) || 0;
    const elapsed = Date.now() - lastWrite;
    const pendingBySession = this.scheduledSnapshots.get(client) || new Map<string, ScheduledSnapshot>();
    const pending = pendingBySession.get(snapshotKey);
    if (!pending && elapsed >= this.snapshotIntervalMs) {
      this.markSnapshotWritten(client, snapshotKey);
      const framed = eventFrame(event);
      if (framed.metadata.originalEventType)
        this.observe("oversized-substitute", framed.metadata);
      this.write(client, framed, snapshotKey);
      return;
    }
    if (pending) {
      pending.event = event;
      this.observe("scheduled-replaced", eventMetadata(event));
      return;
    }
    const delay = Math.max(0, this.snapshotIntervalMs - elapsed);
    const timer = setTimeout(() => this.flushScheduledSnapshot(client, snapshotKey), delay);
    pendingBySession.set(snapshotKey, { event, timer });
    this.scheduledSnapshots.set(client, pendingBySession);
    this.observe("scheduled", eventMetadata(event));
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
    const framed = eventFrame(pending.event);
    if (framed.metadata.originalEventType)
      this.observe("oversized-substitute", framed.metadata);
    this.write(client, framed, snapshotKey);
  }

  private markSnapshotWritten(client: ServerResponse, snapshotKey: string): void {
    const writes = this.lastSnapshotWrites.get(client) || new Map<string, number>();
    writes.set(snapshotKey, Date.now());
    this.lastSnapshotWrites.set(client, writes);
  }

  private write(client: ServerResponse, framed: FramedEvent, snapshotKey?: string): void {
    if (this.backpressured.has(client)) {
      this.enqueue(client, framed, snapshotKey);
      return;
    }
    try {
      if (client.write(framed.frame) !== false) {
        this.observe("written", framed.metadata);
        return;
      }
      this.observe("written-backpressured", framed.metadata);
      this.backpressured.add(client);
      this.waitForDrain(client);
    } catch {
      this.observe("write-error", framed.metadata);
      this.disconnect(client, { reason: "write-error" });
    }
  }

  private enqueue(client: ServerResponse, framed: FramedEvent, snapshotKey?: string): void {
    const pending = this.pendingFrames.get(client) || { frames: [], bytes: 0 };
    const previous = pending.frames.at(-1);
    // Pi assistant events are cumulative snapshots. Coalescing only adjacent
    // snapshots retains order around tool/terminal/session events.
    if (snapshotKey && previous?.snapshotKey === snapshotKey) {
      pending.bytes -= Buffer.byteLength(previous.framed.frame);
      previous.framed = framed;
      this.observe("queue-replaced", framed.metadata);
    } else {
      pending.frames.push({ framed, snapshotKey });
      this.observe("queued", framed.metadata);
    }
    pending.bytes += Buffer.byteLength(framed.frame);
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
      pending.bytes -= Buffer.byteLength(next.framed.frame);
      if (!pending.frames.length) this.pendingFrames.delete(client);
      this.write(client, next.framed, next.snapshotKey);
      if (this.backpressured.has(client) || !this.clients.has(client)) return;
    }
  }

  private observe(
    outcome: SseTransportOutcome,
    metadata: FrameMetadata,
    extra: Pick<SseTransportDiagnostic, "disconnectReason" | "pendingBytes"> = {},
  ): void {
    try {
      this.diagnosticObserver?.({
        outcome,
        ...metadata,
        transportClients: this.clients.size,
        ...extra,
      });
    } catch {
      // Diagnostics are observational only and may never perturb transport.
    }
  }
}
