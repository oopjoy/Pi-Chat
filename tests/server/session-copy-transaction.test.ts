import assert from "node:assert/strict";
import test from "node:test";
import { validateCopiedSessionIdentity } from "../../src/server/services/session-copy-transaction";

test("copy transaction accepts a switched unique Session identity", () => {
  const result = validateCopiedSessionIdentity({
    sourcePath: "C:\\source.jsonl",
    sourceSessionId: "aaaaaaaaaaaaaaaaaaaa",
    sessionIdForPath: () => "bbbbbbbbbbbbbbbbbbbb",
    state: { sessionFile: "C:\\copy.jsonl", sessionId: "pi-copy" },
    knownSessionIds: new Set(),
    liveRuntimeIds: new Set(),
    activeSessionId: "aaaaaaaaaaaaaaaaaaaa",
    cancelled: false,
    mutationOutcomeUnknown: false,
    copyMayHaveCommitted: true,
    installOutcomeFence: () => {},
    mode: "clone",
  });
  assert.deepEqual(result, {
    sessionId: "bbbbbbbbbbbbbbbbbbbb",
    sessionPath: "C:\\copy.jsonl",
    piSessionId: "pi-copy",
  });
});

test("copy transaction rejects duplicate returned identities", () => {
  assert.throws(() => validateCopiedSessionIdentity({
    sourcePath: "C:\\source.jsonl",
    sourceSessionId: "aaaaaaaaaaaaaaaaaaaa",
    sessionIdForPath: () => "bbbbbbbbbbbbbbbbbbbb",
    state: { sessionFile: "C:\\copy.jsonl", sessionId: "pi-copy" },
    knownSessionIds: new Set(["bbbbbbbbbbbbbbbbbbbb"]),
    liveRuntimeIds: new Set(),
    activeSessionId: "aaaaaaaaaaaaaaaaaaaa",
    cancelled: false,
    mutationOutcomeUnknown: false,
    copyMayHaveCommitted: true,
    installOutcomeFence: () => {},
    mode: "clone",
  }), /身份与现有会话冲突/);
});
