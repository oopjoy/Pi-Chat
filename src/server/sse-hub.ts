import type { ServerResponse } from "node:http";

const MAX_SSE_EVENT_BYTES = 512 * 1024;
// A slow local browser must not grow server memory without bound. Normal Pi
// traffic stays far below this because only adjacent cumulative snapshots merge.
const MAX_PENDING_SSE_BYTES = 2 * 1024 * 1024;

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
    const clientId = this.clients.get(response) || "";
    this.clients.delete(response);
    this.backpressured.delete(response);
    this.pendingFrames.delete(response);
    return clientId;
  }

  has(response: ServerResponse): boolean {
    return this.clients.has(response);
  }

  broadcast(event: Record<string, unknown>): void {
    const frame = eventFrame(event);
    const snapshotKey = event.type === "message_start" || event.type === "message_update"
      ? String(event.piChatSessionId || "primary")
      : undefined;
    for (const client of this.clients.keys()) this.write(client, frame, snapshotKey);
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
      try {
        client.end();
      } catch {
        // Shutdown path must not throw.
      }
    }
    this.clients.clear();
    this.backpressured.clear();
    this.pendingFrames.clear();
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
      this.remove(client);
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
      this.remove(client);
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
        this.remove(client);
        return;
      }
    }
  }
}
