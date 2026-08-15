import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserStateDiagnosticsRecorder,
  browserStateDiagnosticSnapshot,
  downloadStateDiagnosticBundle,
  privacySafeStateDiagnosticBundle,
  recordBrowserStateDiagnostic,
} from "../../src/web/lib/state-diagnostics";
import type { StateDiagnosticEntry, StateDiagnosticExportBundle } from "../../src/shared/state-diagnostics";
import { installAppDom } from "../helpers/app-dom";

const SESSION_ID = "0123456789abcdefabcd";
const SECOND_SESSION_ID = "fedcba9876543210abcd";

function status(entryCount: number) {
  return {
    entryCount,
    windowMs: 300_000,
    maximumEntries: 2_000,
    approximateBytes: 0,
    maximumBytes: 1024 * 1024,
  };
}

function entry(source: "server" | "browser", sequence: number, sessionId: string): StateDiagnosticEntry {
  return {
    sequence,
    timestamp: "2026-08-14T12:00:00.000Z",
    source,
    category: "projection",
    name: "ui-state",
    sessionId,
    details: { stateStreaming: true },
  };
}

test("browser state diagnostics is always-on, closed-schema, and fail-open", () => {
  const recorder = new BrowserStateDiagnosticsRecorder();
  recorder.record("projection", "ui-state", {
    sessionId: SESSION_ID,
    runGeneration: 3,
    details: {
      stateStreaming: true,
      queueLength: 2,
      eventType: "secret-token C:\\private\\key.txt",
      errorType: "Bearer private",
      requestToken: "secret-token",
      message: "private prompt",
      content: "private answer",
      cwd: "C:\\private",
      imageData: "base64",
      longValue: "x".repeat(500),
    },
  });
  recorder.record("private", "user-controlled", { details: { running: true } });
  const snapshot = recorder.entriesSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].sessionId, SESSION_ID);
  assert.equal(snapshot[0].runGeneration, 3);
  assert.equal(snapshot[0].details.stateStreaming, true);
  assert.equal(snapshot[0].details.eventType, "unknown");
  assert.equal(snapshot[0].details.errorType, "unknown");
  assert.equal(snapshot[0].details.longValue, undefined);
  const raw = JSON.stringify(snapshot);
  for (const forbidden of [
    "secret-token",
    "private prompt",
    "private answer",
    "C:\\\\private",
    "base64",
  ]) assert.equal(raw.includes(forbidden), false, forbidden);

  const failing = new BrowserStateDiagnosticsRecorder({
    encodeBytes: () => { throw new Error("diagnostic encoder failed"); },
  });
  assert.doesNotThrow(() => failing.record("projection", "ui-state", {
    details: { running: true },
  }));
  assert.equal(failing.entriesSnapshot().length, 0);
});

test("browser singleton records before Settings is opened", () => {
  const before = browserStateDiagnosticSnapshot().status.entryCount;
  recordBrowserStateDiagnostic("diagnostic", "export-requested", {
    sessionId: SESSION_ID,
  });
  const after = browserStateDiagnosticSnapshot();
  assert.equal(after.schemaVersion, 2);
  assert.equal(after.status.entryCount, before + 1);
  assert.equal(after.entries.at(-1)?.name, "export-requested");
});

test("diagnostic export aliases raw Session IDs across both lanes", async () => {
  const { dom } = installAppDom();
  let exported: Blob | null = null;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob: Blob) => {
    exported = blob;
    return "blob:diagnostic";
  };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  try {
    const bundle: StateDiagnosticExportBundle = {
      schemaVersion: 2,
      generatedAt: "2026-08-14T12:00:00.000Z",
      warning: "redacted",
      server: {
        schemaVersion: 2,
        generatedAt: "2026-08-14T12:00:00.000Z",
        runEpoch: "run",
        buildFingerprint: "a".repeat(64),
        status: status(2),
        entries: [entry("server", 1, SESSION_ID), entry("server", 2, SECOND_SESSION_ID)],
      },
      browser: {
        schemaVersion: 2,
        generatedAt: "2026-08-14T12:00:00.000Z",
        pageStartedAt: "2026-08-14T11:59:00.000Z",
        status: status(1),
        entries: [entry("browser", 1, SESSION_ID)],
      },
    };
    const filename = downloadStateDiagnosticBundle(bundle);
    assert.equal(filename, "pi-chat-state-diagnostic-2026-08-14T12-00-00-000Z.json");
    assert.ok(exported);
    const text = await exported.text();
    const parsed = JSON.parse(text) as StateDiagnosticExportBundle;
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.server.buildFingerprint, "a".repeat(64));
    assert.deepEqual(parsed.server.entries.map((item) => item.sessionId), ["s1", "s2"]);
    assert.equal(parsed.browser.entries[0].sessionId, "s1");
    assert.equal(text.includes(SESSION_ID), false);
    assert.equal(text.includes(SECOND_SESSION_ID), false);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  }
});

test("final diagnostic export reconstructs the exact privacy schema", () => {
  const unsafe = {
    schemaVersion: 2,
    generatedAt: "2026-08-14T12:00:00.000Z",
    warning: "private prompt",
    requestToken: "secret-token",
    server: {
      schemaVersion: 2,
      generatedAt: "2026-08-14T12:00:00.000Z",
      runEpoch: "run",
      buildFingerprint: "deadbeefcafebabe",
      secret: "private answer",
      status: status(1),
      entries: [{
        ...entry("server", 1, SESSION_ID),
        path: "C:\\private\\file.txt",
        details: { stateStreaming: true, content: "private answer" },
      }],
    },
    browser: {
      schemaVersion: 2,
      generatedAt: "2026-08-14T12:00:00.000Z",
      pageStartedAt: "2026-08-14T11:59:00.000Z",
      status: status(0),
      entries: [],
    },
  } as unknown as StateDiagnosticExportBundle;
  const safe = privacySafeStateDiagnosticBundle(unsafe);
  assert.equal(safe.server.buildFingerprint, "unknown");
  assert.equal(safe.server.entries[0]?.sessionId, "s1");
  const raw = JSON.stringify(safe);
  for (const forbidden of ["secret-token", "deadbeefcafebabe", "private prompt", "private answer", "C:\\\\private"])
    assert.equal(raw.includes(forbidden), false, forbidden);
});

test("browser diagnostics drops cumulative streaming noise before bounded storage", () => {
  const recorder = new BrowserStateDiagnosticsRecorder({ maximumEntries: 100 });
  for (let index = 0; index < 10_000; index += 1)
    recorder.record("sse", "received", {
      details: { eventType: "message_update", durationMs: index },
    });
  recorder.record("sse", "received", { details: { eventType: "message_end" } });
  assert.deepEqual(
    recorder.entriesSnapshot().map((item) => item.details.eventType),
    ["message_end"],
  );
});
