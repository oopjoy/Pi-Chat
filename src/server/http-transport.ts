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

export function requestClientId(request: IncomingMessage): string {
  const value = request.headers["x-pi-chat-client"];
  const clientId = Array.isArray(value) ? value[0] : value;
  return typeof clientId === "string" && /^[a-f0-9-]{20,64}$/i.test(clientId) ? clientId : "";
}

export async function bodyJson(request: IncomingMessage, maximumBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error(`请求内容超过 ${Math.round(maximumBytes / 1_000_000)} MB`);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}
