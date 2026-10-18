import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "../http-transport.js";

export async function handleSessionReferenceRoute(
  host: { sessionFile(sessionId: string): Promise<string> },
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = /^\/api\/sessions\/([a-f0-9]{20})\/session-file$/.exec(url.pathname);
  if (!match) return false;
  if (request.method !== "GET") { response.statusCode = 405; response.end(); return true; }
  // Read-only: this exposes the server-verified JSONL address for Pi Chat
  // launchers to resolve. It does not open, copy, mutate or grant authority.
  json(response, 200, { sessionId: match[1], sessionFile: await host.sessionFile(match[1]) });
  return true;
}
