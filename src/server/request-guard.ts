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

function normalizeHost(value: string): { authority: string; hostname: string } | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    // Host is an HTTP authority, never a URL. Reject path/query/fragment and
    // credentials before comparing it to the exact loopback listener; otherwise
    // the tokenless handoff health exception could accept disguised Hosts.
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || raw !== parsed.host) return null;
    return { authority: parsed.host, hostname: parsed.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

export function requestGuardError(request: IncomingMessage, options: RequestGuardOptions): string | null {
  const parsedHost = normalizeHost(header(request, "host"));
  if (!parsedHost) return "请求 Host 未获允许";
  const allowed = options.allowedHosts.map(normalizeHost).filter((value): value is { authority: string; hostname: string } => Boolean(value));
  const hostAllowed = allowed.some((item) => item.authority === parsedHost.authority || (item.authority === item.hostname && item.hostname === parsedHost.hostname));
  if (!hostAllowed) return "请求 Host 未获允许";
  // Bare loopback entries are intentionally a test-only wildcard-port mode.
  // Production calls set one exact authority after listen(), so they always
  // require the ephemeral token below.
  const requiresToken = allowed.some((item) => item.authority === parsedHost.authority && item.authority !== item.hostname);

  const origin = header(request, "origin");
  // Navigation GETs commonly omit Origin. API and SSE requests must always identify
  // the Pi Chat page that initiated them, except the initial read-only bootstrap that
  // provides the in-memory startup token.
  if (origin) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return "请求 Origin 无效"; }
    const originHost = normalizeHost(parsed.host);
    if (parsed.protocol !== "http:" || !originHost || !allowed.some((item) => item.authority === originHost.authority || (item.authority === item.hostname && item.hostname === originHost.hostname))) return "请求 Origin 未获允许";
  }

  const url = new URL(request.url || "/", "http://localhost");
  const pathname = url.pathname;
  const headerToken = header(request, "x-pi-chat-token");
  const fetchSite = header(request, "sec-fetch-site");
  // The restart handoff is a separate local process, not a browser: after exact
  // Host validation it may make this one fixed-shape liveness request without
  // Origin or the in-memory token. No other API endpoint has this exception.
  const isTokenlessHealthProbe = pathname === "/api/health" && request.method === "GET" && !origin && !fetchSite && !headerToken;
  if (isTokenlessHealthProbe) return null;
  // This is the one bootstrap handshake that obtains the ephemeral token. Every
  // other API/SSE call, including tokenless local automation, must authenticate.
  const isInitialBootstrap = pathname === "/api/bootstrap/handshake" && request.method === "GET" && !headerToken;
  if (pathname.startsWith("/api/") || pathname === "/api/events") {
    const queryTokenRoute = pathname === "/api/events" || pathname === "/api/window/close";
    const hasRequestIdentity = Boolean(origin || fetchSite || headerToken || (queryTokenRoute && url.searchParams.has("token")));
    if ((requiresToken || hasRequestIdentity) && !origin && !isInitialBootstrap && fetchSite !== "same-origin") return "请求缺少同源 Origin";
    const suppliedToken = queryTokenRoute ? url.searchParams.get("token") || headerToken : headerToken;
    if ((requiresToken || hasRequestIdentity) && !isInitialBootstrap && !sameToken(suppliedToken, options.token)) return "Pi Chat 请求令牌无效或已过期";
  }
  return null;
}
