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
    return clientId;
  }

  has(response: ServerResponse): boolean {
    return this.clients.has(response);
  }

  broadcast(event: Record<string, unknown>): void {
    const frame = eventFrame(event);
    for (const client of this.clients.keys()) this.write(client, frame);
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
  }

  private write(client: ServerResponse, frame: string): void {
    if (this.backpressured.has(client)) return;
    try {
      if (client.write(frame) !== false) return;
      this.backpressured.add(client);
      client.once("drain", () => {
        if (!this.clients.has(client)) return;
        this.backpressured.delete(client);
        this.write(client, eventFrame({ type: "pi_chat_sse_resync" }));
      });
    } catch {
      this.remove(client);
    }
  }
}
