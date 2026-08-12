import type { IncomingMessage } from "node:http";
import { MAX_PROMPT_HTTP_BODY_BYTES } from "../shared/rpc-contracts.js";

export type ApiRouteAdmission = {
  bodyBeforeMutationLease: boolean;
  /** Existing-session mutations validate sessionId before admission; New does not. */
  validateSessionId: boolean;
  bodyLimit?: number;
  ordinaryMutation: boolean;
};

export const PROMPT_BODY_LIMIT = MAX_PROMPT_HTTP_BODY_BYTES;

const SESSION_BODY_MUTATIONS = new Set([
  "/api/chat/prompt",
  "/api/chat/queue/resume",
  "/api/chat/compact",
  "/api/chat/abort",
  "/api/models/set",
  "/api/thinking/set",
  "/api/extension-ui/respond",
]);

/** Transport-only lifecycle admission classification; no App state is consulted. */
export function apiRouteAdmission(request: IncomingMessage, url: URL): ApiRouteAdmission {
  const sessionBodyMutation = request.method === "POST" && SESSION_BODY_MUTATIONS.has(url.pathname)
    || request.method === "DELETE" && /^\/api\/chat\/queue\/[a-f0-9-]{36}$/.test(url.pathname);
  if (sessionBodyMutation) {
    return {
      bodyBeforeMutationLease: true,
      validateSessionId: true,
      ...(url.pathname === "/api/chat/prompt" ? { bodyLimit: PROMPT_BODY_LIMIT } : null),
      ordinaryMutation: false,
    };
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/new")
    return { bodyBeforeMutationLease: true, validateSessionId: false, bodyLimit: PROMPT_BODY_LIMIT, ordinaryMutation: false };
  if (request.method === "GET" || request.method === "HEAD")
    return { bodyBeforeMutationLease: false, validateSessionId: false, ordinaryMutation: false };
  const excluded = [
    "/api/restart", "/api/shutdown", "/api/window/close", "/api/presence",
    "/api/workspace/pick", "/api/workspace/set", "/api/workspace/draft-pick",
    "/api/local-files/pick", "/api/local-files/clipboard", "/api/sessions/viewing/clear",
  ].includes(url.pathname)
    || url.pathname.startsWith("/api/resources/")
    || url.pathname === "/api/models"
    || /^\/api\/models\/[A-Za-z0-9._-]{1,80}\//.test(url.pathname)
    || /^\/api\/sessions\/[a-f0-9]{20}\/viewing$/.test(url.pathname);
  return { bodyBeforeMutationLease: false, validateSessionId: false, ordinaryMutation: !excluded };
}
