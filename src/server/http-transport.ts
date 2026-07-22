import type { IncomingMessage, ServerResponse } from "node:http";

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
};
const JSON_HEADERS = { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

export function methodNotAllowed(response: ServerResponse): void {
  json(response, 405, { error: "Method not allowed" });
}

const CLIENT_ID_PATTERN = /^[a-f0-9-]{20,64}$/i;

export function requestClientId(request: IncomingMessage): string {
  const value = request.headers["x-pi-chat-client"];
  const headerClientId = Array.isArray(value) ? value[0] : value;
  if (typeof headerClientId === "string" && CLIENT_ID_PATTERN.test(headerClientId)) return headerClientId;
  // Native EventSource cannot set X-Pi-Chat-Client, so SSE carries the same
  // non-secret window identity in its guarded same-origin query string.
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/api/events") return "";
    const queryClientId = url.searchParams.get("client") || "";
    return CLIENT_ID_PATTERN.test(queryClientId) ? queryClientId : "";
  } catch {
    return "";
  }
}

export class HttpRequestError extends Error {
  constructor(readonly status: 400 | 413, message: string) { super(message); }
}

export async function bodyJson(request: IncomingMessage, maximumBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) {
      // Keep draining the local request instead of destroying its socket, so
      // the browser reliably receives 413 rather than ECONNRESET.
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new HttpRequestError(413, `请求内容超过 ${Math.round(maximumBytes / 1_000_000)} MB`);
  if (!chunks.length) return {};
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpRequestError(400, "请求内容不是有效 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpRequestError(400, "请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}
