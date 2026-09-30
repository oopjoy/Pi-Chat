import type { IncomingMessage, ServerResponse } from "node:http";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";
import { requiredSessionId } from "./request-validation.js";

export interface ExtensionResponseRouteHost {
  respond(input: {
    sessionId: string;
    requestId: string;
    cancelled?: boolean;
    confirmed?: boolean;
    value?: string;
  }): Promise<void>;
}

export async function handleExtensionResponseRoute(
  host: ExtensionResponseRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  preparedBody?: Record<string, unknown>,
): Promise<boolean> {
  if (url.pathname !== "/api/extension-ui/respond") return false;
  if (request.method !== "POST") {
    methodNotAllowed(response);
    return true;
  }
  const body = preparedBody || await bodyJson(request);
  if (typeof body.id !== "string") {
    json(response, 400, { error: "id 必填" });
    return true;
  }
  const sessionId = requiredSessionId(body);
  await host.respond({
    sessionId,
    requestId: body.id,
    ...(body.cancelled === true ? { cancelled: true } : null),
    ...(typeof body.confirmed === "boolean" ? { confirmed: body.confirmed } : null),
    ...(typeof body.value === "string" ? { value: body.value } : null),
  });
  json(response, 200, { ok: true });
  return true;
}
