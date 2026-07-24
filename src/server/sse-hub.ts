import type { ServerResponse } from "node:http";

const MAX_SSE_EVENT_BYTES = 512 * 1024;

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

/**
 * Owns SSE client sockets and fan-out only.
 * Does not interpret Pi events, queues, or session control policy.
 */
export class SseHub {
  private readonly clients = new Map<ServerResponse, string>();
  private readonly backpressured = new Set<ServerResponse>();
  /** Latest cumulative assistant snapshot per Session while a socket is congested. */
  private readonly pendingMessageFrames = new Map<ServerResponse, Map<string, string>>();

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
    this.pendingMessageFrames.delete(response);
    return clientId;
  }

  has(response: ServerResponse): boolean {
    return this.clients.has(response);
  }

  broadcast(event: Record<string, unknown>): void {
    const frame = eventFrame(event);
    const retainKey = event.type === "message_start" || event.type === "message_update"
      ? String(event.piChatSessionId || "primary")
      : "";
    for (const client of this.clients.keys()) this.write(client, frame, retainKey);
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
    this.pendingMessageFrames.clear();
  }

  private write(client: ServerResponse, frame: string, retainKey = ""): void {
    if (this.backpressured.has(client)) {
      // Assistant updates are cumulative snapshots. Coalesce the latest one per
      // Session instead of dropping every visible update until drain; other
      // intermediate frames remain disposable because resync is authoritative.
      if (retainKey) {
        const pending = this.pendingMessageFrames.get(client) || new Map<string, string>();
        pending.set(retainKey, frame);
        this.pendingMessageFrames.set(client, pending);
      }
      return;
    }
    try {
      if (client.write(frame) !== false) return;
      this.backpressured.add(client);
      client.once("drain", () => {
        if (!this.clients.has(client)) return;
        this.backpressured.delete(client);
        const pending = this.pendingMessageFrames.get(client);
        while (pending?.size) {
          const [sessionId, latestMessage] = pending.entries().next().value as [string, string];
          pending.delete(sessionId);
          if (!pending.size) this.pendingMessageFrames.delete(client);
          this.write(client, latestMessage);
          // A retained snapshot may fill the socket again. Leave snapshots for
          // other Sessions queued so its next drain can continue the replay.
          if (this.backpressured.has(client)) return;
        }
        this.write(client, eventFrame({ type: "pi_chat_sse_resync" }));
      });
    } catch {
      this.remove(client);
    }
  }
}
