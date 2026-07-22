import type { ServerResponse } from "node:http";

/**
 * Owns SSE client sockets and fan-out only.
 * Does not interpret Pi events, queues, or session control policy.
 */
export class SseHub {
  private readonly clients = new Map<ServerResponse, string>();

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
    return clientId;
  }

  has(response: ServerResponse): boolean {
    return this.clients.has(response);
  }

  broadcast(event: Record<string, unknown>): void {
    const frame = `event: pi\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients.keys()) {
      try {
        client.write(frame);
      } catch {
        // Drop broken sockets on the next close; do not throw into RPC handlers.
      }
    }
  }

  /**
   * Per-connection frames (e.g. control ownership looks different per window).
   * Builder may return null to skip a client.
   */
  broadcastEach(build: (clientId: string) => Record<string, unknown> | null): void {
    for (const [client, clientId] of this.clients) {
      const event = build(clientId);
      if (!event) continue;
      try {
        client.write(`event: pi\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Ignore broken sockets.
      }
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
  }
}
