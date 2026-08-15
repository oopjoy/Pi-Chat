import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { apiRouteAdmission, PROMPT_BODY_LIMIT } from "../src/server/api-route-admission";
import { MAX_PROMPT_HTTP_BODY_BYTES } from "../src/shared/rpc-contracts";

function route(method: string, path: string) {
  return apiRouteAdmission({ method } as IncomingMessage, new URL(path, "http://127.0.0.1"));
}

test("prompt HTTP admission shares the RPC transport budget authority", () => {
  assert.equal(PROMPT_BODY_LIMIT, MAX_PROMPT_HTTP_BODY_BYTES);
});

test("session-body routes parse and validate before acquiring a lifecycle lease", () => {
  assert.deepEqual(route("POST", "/api/chat/prompt"), {
    bodyBeforeMutationLease: true, validateSessionId: true, bodyLimit: PROMPT_BODY_LIMIT, ordinaryMutation: false,
  });
  assert.deepEqual(route("POST", "/api/chat/abort"), {
    bodyBeforeMutationLease: true, validateSessionId: true, ordinaryMutation: false,
  });
  assert.deepEqual(route("DELETE", "/api/chat/queue/11111111-1111-1111-1111-111111111111"), {
    bodyBeforeMutationLease: true, validateSessionId: true, ordinaryMutation: false,
  });
  assert.deepEqual(route("POST", "/api/sessions/new"), {
    bodyBeforeMutationLease: true, validateSessionId: false, bodyLimit: PROMPT_BODY_LIMIT, ordinaryMutation: false,
  });
});

test("route admission preserves lifecycle and read exclusions", () => {
  assert.deepEqual(route("GET", "/api/sessions"), { bodyBeforeMutationLease: false, validateSessionId: false, ordinaryMutation: false });
  assert.deepEqual(route("POST", "/api/restart"), { bodyBeforeMutationLease: false, validateSessionId: false, ordinaryMutation: false });
  assert.deepEqual(route("POST", "/api/workspace/set"), { bodyBeforeMutationLease: false, validateSessionId: false, ordinaryMutation: false });
  assert.deepEqual(route("POST", "/api/resources/browse"), { bodyBeforeMutationLease: false, validateSessionId: false, ordinaryMutation: false });
  assert.deepEqual(route("GET", "/api/diagnostics/snapshot"), { bodyBeforeMutationLease: false, validateSessionId: false, ordinaryMutation: false });
  assert.deepEqual(route("PATCH", "/api/sessions/0123456789abcdefabcd"), { bodyBeforeMutationLease: false, validateSessionId: false, ordinaryMutation: true });
});
