import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import { idForPath } from "../../src/server/session-index";
import type { SessionIndex } from "../../src/server/session-index";
import type { ResourceManager } from "../../src/server/resource-manager";
import type { ServerStateDiagnosticSnapshot, StateDiagnosticStatus } from "../../src/shared/state-diagnostics";
import { FakeRpc } from "../helpers/server-app-fixture";

async function fixture() {
  const path = "C:\\sessions\\diagnostic-state.jsonl";
  const id = idForPath(path);
  const rpc = new FakeRpc(path, "diagnostic-state");
  const summary = {
    id,
    sessionId: "diagnostic-state",
    name: "Diagnostic",
    preview: "",
    cwd: process.cwd(),
    updatedAt: 1,
    messageCount: 1,
    active: true,
  };
  const sessions = {
    list: async () => [summary],
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: (candidate: string) => candidate === id ? summary : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    buildIdentity: {
      schemaVersion: 1,
      packageVersion: "test",
      revision: "diagnostic-revision",
      fingerprint: "a".repeat(64),
      builtAt: new Date(0).toISOString(),
    },
    runEpoch: "diagnostic-run",
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    app,
    rpc,
    id,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => { server.close(); await app.close(); },
  };
}

test("diagnostic routes capture redacted API, RPC, SSE, and projection state", async () => {
  const target = await fixture();
  const ownerHeaders = {
    "x-pi-chat-client": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "x-pi-chat-page": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  try {
    assert.equal((await fetch(`${target.origin}/api/bootstrap/handshake`, {
      headers: ownerHeaders,
    })).status, 200);
    const start = await fetch(`${target.origin}/api/diagnostics/start`, {
      method: "POST",
      headers: ownerHeaders,
    });
    assert.equal(start.status, 200);
    const started = (await start.json()) as StateDiagnosticStatus;
    assert.equal(started.active, true);
    assert.match(started.captureId || "", /^[a-f0-9]{24}$/);
    const captureHeaders = {
      ...ownerHeaders,
      "x-pi-chat-diagnostic-capture": started.captureId || "",
    };

    assert.equal((await fetch(`${target.origin}/api/bootstrap`)).status, 200);
    target.rpc.emit({
      type: "tool_execution_start",
      toolName: "bash",
      message: "private prompt",
      content: "private answer",
      cwd: "C:\\private",
      requestToken: "secret-token",
    });
    target.rpc.emit({ type: "secret-token C:\\private\\key.txt" });
    assert.equal((await fetch(`${target.origin}/api/sessions/${target.id}/view`)).status, 200);
    const malformed = await fetch(`${target.origin}/api/chat/prompt`, {
      method: "POST",
      headers: {
        ...ownerHeaders,
        "content-type": "application/json",
      },
      body: "{",
    });
    assert.equal(malformed.status, 400);

    const response = await fetch(`${target.origin}/api/diagnostics/snapshot`, {
      headers: captureHeaders,
    });
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as ServerStateDiagnosticSnapshot;
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.runEpoch, "diagnostic-run");
    assert.equal(snapshot.buildRevision, "diagnostic-revision");
    assert.equal(snapshot.status.active, true);
    assert.ok(snapshot.entries.some((entry) =>
      entry.category === "rpc-event" &&
      entry.details.eventType === "tool_execution_start",
    ));
    assert.ok(snapshot.entries.some((entry) =>
      entry.category === "sse" && entry.details.eventType === "tool_execution_start",
    ));
    assert.ok(snapshot.entries.some((entry) =>
      entry.category === "sse-transport" &&
      entry.name === "no-clients" &&
      entry.details.eventType === "tool_execution_start",
    ));
    assert.ok(snapshot.entries.some((entry) =>
      entry.category === "rpc-event" && entry.details.eventType === "unknown",
    ));
    assert.ok(snapshot.entries.some((entry) =>
      entry.category === "projection" && entry.name === "bootstrap",
    ));
    assert.ok(snapshot.entries.some((entry) =>
      entry.category === "projection" && entry.name === "session-view",
    ));
    const failedRequest = snapshot.entries.filter((entry) =>
      entry.category === "http" && entry.details.route === "/api/chat/prompt",
    );
    assert.deepEqual(
      failedRequest.map((entry) => entry.name),
      ["request-start", "request-error", "request-end"],
    );
    assert.equal(failedRequest.at(-1)?.details.status, 400);
    const raw = JSON.stringify(snapshot);
    for (const forbidden of [
      "private prompt",
      "private answer",
      "C:\\\\private",
      "secret-token",
    ]) assert.equal(raw.includes(forbidden), false, forbidden);

    const stop = await fetch(`${target.origin}/api/diagnostics/stop`, {
      method: "POST",
      headers: captureHeaders,
    });
    assert.equal(stop.status, 200);
    assert.equal(((await stop.json()) as StateDiagnosticStatus).active, false);
    const stoppedCount = ((await (await fetch(`${target.origin}/api/diagnostics/snapshot`, {
      headers: captureHeaders,
    })).json()) as ServerStateDiagnosticSnapshot).entries.length;
    target.rpc.emit({ type: "agent_settled" });
    const after = (await (await fetch(`${target.origin}/api/diagnostics/snapshot`, {
      headers: captureHeaders,
    })).json()) as ServerStateDiagnosticSnapshot;
    assert.equal(after.entries.length, stoppedCount);
  } finally {
    await target.close();
  }
});

test("closing the final owning page releases capture without letting a stale page close its replacement", async () => {
  const target = await fixture();
  const clientA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const oldPage = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const newPage = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const ownerB = {
    "x-pi-chat-client": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "x-pi-chat-page": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  const pageHeaders = (pageId: string) => ({
    "x-pi-chat-client": clientA,
    "x-pi-chat-page": pageId,
  });
  try {
    assert.equal((await fetch(`${target.origin}/api/bootstrap/handshake`, {
      headers: pageHeaders(oldPage),
    })).status, 200);
    assert.equal((await fetch(`${target.origin}/api/bootstrap/handshake`, {
      headers: pageHeaders(newPage),
    })).status, 200);
    assert.equal((await fetch(`${target.origin}/api/bootstrap/handshake`, {
      headers: ownerB,
    })).status, 200);
    assert.equal((await fetch(`${target.origin}/api/diagnostics/start`, {
      method: "POST",
      headers: pageHeaders(newPage),
    })).status, 200);

    assert.equal((await fetch(`${target.origin}/api/window/close`, {
      method: "POST",
      headers: pageHeaders(oldPage),
    })).status, 200);
    assert.equal((await fetch(`${target.origin}/api/diagnostics/start`, {
      method: "POST",
      headers: ownerB,
    })).status, 409, "a stale page close must not release its replacement's capture");

    assert.equal((await fetch(`${target.origin}/api/window/close`, {
      method: "POST",
      headers: pageHeaders(newPage),
    })).status, 200);
    const delayedClosedPageStart = await fetch(`${target.origin}/api/diagnostics/start`, {
      method: "POST",
      headers: pageHeaders(newPage),
    });
    assert.equal(delayedClosedPageStart.status, 409);
    assert.equal(
      ((await delayedClosedPageStart.json()) as { code?: string }).code,
      "DIAGNOSTIC_PAGE_NOT_REGISTERED",
    );
    assert.equal((await fetch(`${target.origin}/api/diagnostics/start`, {
      method: "POST",
      headers: ownerB,
    })).status, 200, "the final owning page close releases capture for another window");
  } finally {
    await target.close();
  }
});

test("diagnostic capture IDs prevent one window from resetting or exporting another window's capture", async () => {
  const target = await fixture();
  const ownerA = {
    "x-pi-chat-client": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "x-pi-chat-page": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  const ownerB = {
    "x-pi-chat-client": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "x-pi-chat-page": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  try {
    assert.equal((await fetch(`${target.origin}/api/bootstrap/handshake`, {
      headers: ownerA,
    })).status, 200);
    assert.equal((await fetch(`${target.origin}/api/bootstrap/handshake`, {
      headers: ownerB,
    })).status, 200);
    const first = await fetch(`${target.origin}/api/diagnostics/start`, {
      method: "POST",
      headers: ownerA,
    });
    assert.equal(first.status, 200);
    const firstStatus = (await first.json()) as StateDiagnosticStatus;
    assert.ok(firstStatus.captureId);

    const conflictingStart = await fetch(`${target.origin}/api/diagnostics/start`, {
      method: "POST",
      headers: ownerB,
    });
    assert.equal(conflictingStart.status, 409);
    assert.equal((await conflictingStart.json() as { code?: string }).code, "DIAGNOSTIC_CAPTURE_IN_USE");

    const foreignSnapshot = await fetch(`${target.origin}/api/diagnostics/snapshot`, {
      headers: {
        ...ownerB,
        "x-pi-chat-diagnostic-capture": firstStatus.captureId || "",
      },
    });
    assert.equal(foreignSnapshot.status, 409);

    const restarted = await fetch(`${target.origin}/api/diagnostics/start`, {
      method: "POST",
      headers: ownerA,
    });
    assert.equal(restarted.status, 200);
    const restartedStatus = (await restarted.json()) as StateDiagnosticStatus;
    assert.ok(restartedStatus.captureId);
    assert.notEqual(restartedStatus.captureId, firstStatus.captureId);

    const staleSnapshot = await fetch(`${target.origin}/api/diagnostics/snapshot`, {
      headers: {
        ...ownerA,
        "x-pi-chat-diagnostic-capture": firstStatus.captureId || "",
      },
    });
    assert.equal(staleSnapshot.status, 409);

    const stopped = await fetch(`${target.origin}/api/diagnostics/stop`, {
      method: "POST",
      headers: {
        ...ownerA,
        "x-pi-chat-diagnostic-capture": restartedStatus.captureId || "",
      },
    });
    assert.equal(stopped.status, 200);

    const secondWindowStart = await fetch(`${target.origin}/api/diagnostics/start`, {
      method: "POST",
      headers: ownerB,
    });
    assert.equal(secondWindowStart.status, 200);
  } finally {
    await target.close();
  }
});
