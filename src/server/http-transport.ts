import type { IncomingMessage, ServerResponse } from "node:http";

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; connect-src 'self' https://api.github.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
};
const JSON_HEADERS = { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
/** Request bodies must not hold a lifecycle/mutation admission indefinitely. */
export const DEFAULT_HTTP_BODY_TIMEOUT_MS = 120_000;
/** After returning a clean 408, give a peer a short grace period before closing its transport. */
export const DEFAULT_HTTP_BODY_DRAIN_TIMEOUT_MS = 5_000;

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

function requestIdentity(request: IncomingMessage, headerName: string, queryName: string): string {
  const value = request.headers[headerName];
  const headerValue = Array.isArray(value) ? value[0] : value;
  if (typeof headerValue === "string" && CLIENT_ID_PATTERN.test(headerValue)) return headerValue;
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/api/events" && url.pathname !== "/api/window/close") return "";
    const queryValue = url.searchParams.get(queryName) || "";
    return CLIENT_ID_PATTERN.test(queryValue) ? queryValue : "";
  } catch {
    return "";
  }
}

export function requestClientId(request: IncomingMessage): string {
  return requestIdentity(request, "x-pi-chat-client", "client");
}

export function requestPageId(request: IncomingMessage): string {
  return requestIdentity(request, "x-pi-chat-page", "page");
}

export class HttpRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 408 | 409 | 413 | 503,
    message: string,
    readonly code = "HTTP_REQUEST_REJECTED",
    readonly retryable = false,
    readonly outcomeUnknown = false,
  ) { super(message); }
}

export async function bodyJson(
  request: IncomingMessage,
  maximumBytes = 1_000_000,
  timeoutMs = DEFAULT_HTTP_BODY_TIMEOUT_MS,
  drainTimeoutMs = DEFAULT_HTTP_BODY_DRAIN_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const read = (async () => {
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
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        reject(new HttpRequestError(408, "请求体接收超时，请重新提交"));
      },
      Math.max(1, timeoutMs),
    );
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!timedOut) {
      void read.catch(() => undefined);
    } else {
      // Continue draining briefly so the caller can send a clean 408 rather than
      // resetting the socket immediately. A peer that drips bytes forever must
      // still lose its transport after this second, bounded deadline.
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const clearDrainTimer = () => {
        if (drainTimer) clearTimeout(drainTimer);
        drainTimer = undefined;
      };
      drainTimer = setTimeout(() => {
        if (request.complete || request.destroyed) return;
        try { request.destroy(); } catch { /* transport cleanup is best effort */ }
      }, Math.max(1, drainTimeoutMs));
      drainTimer.unref?.();
      void read
        .catch(() => undefined)
        .then(clearDrainTimer, clearDrainTimer);
    }
  }
}
