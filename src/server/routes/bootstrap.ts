import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApplicationLifecycle, BootstrapData, BuildIdentity, HealthData } from "../../shared/types.js";
import { json, methodNotAllowed } from "../http-transport.js";

export type BootstrapRouteHost = {
  lifecycle(): ApplicationLifecycle;
  assertBootstrapAllowed(): void;
  requestToken(): string;
  buildIdentity(): BuildIdentity;
  openWindowCount(): number;
  cancelLastWindowShutdown(): void;
  scheduleLastWindowShutdown(): void;
  bootstrap(clientId: string): Promise<BootstrapData>;
};

/** Health and bootstrap are read routes; lifecycle ownership stays in PiChatApp. */
export async function handleBootstrapRoute(
  host: BootstrapRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  clientId: string,
): Promise<boolean> {
  if (url.pathname === "/api/health") {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return true;
    }
    json(response, 200, {
      ok: true,
      service: "pi-chat",
      lifecycle: host.lifecycle(),
      buildIdentity: host.buildIdentity(),
    } satisfies HealthData);
    return true;
  }
  if (url.pathname === "/api/bootstrap/handshake") {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return true;
    }
    json(response, 200, {
      requestToken: host.requestToken(),
      buildIdentity: host.buildIdentity(),
    });
    return true;
  }
  if (url.pathname !== "/api/bootstrap") return false;
  if (request.method !== "GET") {
    methodNotAllowed(response);
    return true;
  }
  host.assertBootstrapAllowed();
  // Bootstrap precedes EventSource creation. Reset the grace immediately so a
  // page reopening without a transport cannot be shut down during its scan.
  const reopeningWithoutTransport = Boolean(clientId) && host.openWindowCount() === 0;
  if (reopeningWithoutTransport) host.cancelLastWindowShutdown();
  const data = await host.bootstrap(clientId);
  if (reopeningWithoutTransport && host.openWindowCount() === 0)
    host.scheduleLastWindowShutdown();
  json(response, 200, { ...data, requestToken: host.requestToken() });
  return true;
}
