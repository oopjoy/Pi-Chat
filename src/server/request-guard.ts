import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface RequestGuardOptions {
  /** Exact host:port values. A bare localhost address is a test-only wildcard port. */
  allowedHosts: string[];
  token: string;
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function sameToken(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function requestGuardError(request: IncomingMessage, options: RequestGuardOptions): string | null {
  const host = header(request, "host").toLowerCase();
  const allowedHosts = new Set(options.allowedHosts.map((item) => item.toLowerCase()));
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  const hostAllowed = allowedHosts.has(host) || allowedHosts.has(hostname);
  if (!hostAllowed) return "请求 Host 未获允许";

  const origin = header(request, "origin");
  // Navigation GETs commonly omit Origin. API and SSE requests must always identify
  // the Pi Chat page that initiated them, except the initial read-only bootstrap that
  // provides the in-memory startup token.
  if (origin) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return "请求 Origin 无效"; }
    const originHost = parsed.host.toLowerCase();
    const originName = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "http:" || (!allowedHosts.has(originHost) && !allowedHosts.has(originName))) return "请求 Origin 未获允许";
  }

  const url = new URL(request.url || "/", "http://localhost");
  const pathname = url.pathname;
  const headerToken = header(request, "x-pi-chat-token");
  const fetchSite = header(request, "sec-fetch-site");
  const browserRequest = Boolean(origin || fetchSite);
  // This is the one bootstrap handshake that obtains the ephemeral token. It is
  // still Host/Origin checked above, so another website cannot read or obtain it.
  const isInitialBootstrap = pathname === "/api/bootstrap" && request.method === "GET" && !headerToken;
  if ((pathname.startsWith("/api/") || pathname === "/api/events") && browserRequest) {
    if (!origin && !isInitialBootstrap && fetchSite !== "same-origin") return "请求缺少同源 Origin";
    const suppliedToken = pathname === "/api/events" ? url.searchParams.get("token") || "" : headerToken;
    if (!isInitialBootstrap && !sameToken(suppliedToken, options.token)) return "Pi Chat 请求令牌无效或已过期";
  }
  return null;
}
