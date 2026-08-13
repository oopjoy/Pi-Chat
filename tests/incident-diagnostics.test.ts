import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createIncidentDiagnostics,
  incidentMessage,
  recordIncident,
} from "../src/server/incident-diagnostics";

const expectedKeys = [
  "timestamp", "incidentId", "hostId", "runEpoch", "revision",
  "sessionHash", "browserHash", "pageHash", "runtimeKind",
  "rpcGeneration", "rpcRequestId", "childPid", "operation",
  "lifecycle", "queueLength", "controlState", "outcome",
  "durationMs", "errorCode",
].sort();

async function fixture(maximumBytes = 5 * 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-incidents-"));
  const directory = join(root, "diagnostics");
  const diagnostics = await createIncidentDiagnostics({
    directory,
    runEpoch: "run-epoch-safe",
    revision: "revision-safe",
    maximumBytes,
    archiveCount: 2,
    key: Buffer.alloc(32, 0x5a),
    now: () => new Date("2026-08-12T16:42:11.402Z"),
  });
  return { root, directory, diagnostics };
}

test("incident diagnostics writes fixed metadata-only JSONL", async () => {
  const { root, directory, diagnostics } = await fixture();
  const session = "session-private-sentinel";
  const browser = "browser-private-sentinel";
  try {
    const first = diagnostics.record({
      sessionId: session,
      browserId: browser,
      pageId: "page-private-sentinel",
      runtimeKind: "secondary",
      rpcGeneration: 3,
      rpcRequestId: "pi-chat-42",
      childPid: 18472,
      operation: "runtime.settlement",
      queueLength: 1,
      controlState: "owned-by-this-window",
      outcome: "written-outcome-unknown",
      durationMs: 10003,
      errorCode: "PI_RPC_REQUEST_TIMEOUT",
    });
    diagnostics.record({
      sessionId: session,
      browserId: browser,
      runtimeKind: "secondary",
      operation: "runtime.recovery",
      outcome: "failed",
      errorCode: "RUNTIME_RECOVERY_FAILED",
    });
    await diagnostics.flush();

    assert.match(first.incidentId, /^PC-[A-Z0-9_-]{8}$/);
    const raw = await readFile(join(directory, "incidents.jsonl"), "utf8");
    assert.equal(raw.includes(session), false);
    assert.equal(raw.includes(browser), false);
    assert.equal(raw.includes("prompt"), false);
    assert.equal(raw.includes("toolOutput"), false);
    const records = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(Object.keys(records[0]).sort(), expectedKeys);
    assert.equal(records[0].sessionHash, records[1].sessionHash);
    assert.equal(records[0].browserHash, records[1].browserHash);
    assert.notEqual(records[0].sessionHash, records[0].browserHash);
  } finally {
    await diagnostics.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incident diagnostics rotates bounded JSONL files", async () => {
  const { root, directory, diagnostics } = await fixture(4096);
  try {
    for (let index = 0; index < 60; index += 1) {
      diagnostics.record({
        sessionId: `session-${index % 3}`,
        runtimeKind: "secondary",
        rpcGeneration: index,
        childPid: 1000 + index,
        operation: "rpc.child-exit",
        queueLength: index % 5,
        outcome: "failed",
        errorCode: "RPC_CHILD_EXIT",
      });
    }
    await diagnostics.flush();
    const files = (await readdir(directory)).filter((name) => name.startsWith("incidents.jsonl"));
    assert.ok(files.includes("incidents.jsonl"));
    assert.ok(files.includes("incidents.jsonl.1"));
    assert.ok(files.length <= 3);
  } finally {
    await diagnostics.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incident references are reused and format in existing UI", async () => {
  const { root, diagnostics } = await fixture();
  try {
    const error = new Error("message is not serialized");
    const first = recordIncident(diagnostics, error, {
      runtimeKind: "primary",
      operation: "rpc.abort",
      outcome: "not-written",
      errorCode: "PI_RPC_REQUEST_TIMEOUT",
    });
    const second = recordIncident(diagnostics, error, {
      runtimeKind: "primary",
      operation: "runtime.recovery",
      outcome: "failed",
      errorCode: "PRIMARY_RUNTIME_UNAVAILABLE",
    });
    assert.equal(first.incidentId, second.incidentId);
    assert.equal(
      incidentMessage("请求失败", first.incidentId),
      `请求失败（事件 ID：${first.incidentId}）`,
    );
  } finally {
    await diagnostics.close();
    await rm(root, { recursive: true, force: true });
  }
});
