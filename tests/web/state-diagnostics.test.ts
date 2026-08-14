import assert from "node:assert/strict";
import test from "node:test";
import {
  bindBrowserStateDiagnosticCaptureId,
  browserStateDiagnosticSnapshot,
  browserStateDiagnosticStatus,
  downloadStateDiagnosticBundle,
  recordBrowserStateDiagnostic,
  startBrowserStateDiagnostics,
  stopBrowserStateDiagnostics,
} from "../../src/web/lib/state-diagnostics";
import type { StateDiagnosticExportBundle } from "../../src/shared/state-diagnostics";
import { installAppDom } from "../helpers/app-dom";

const SESSION_ID = "0123456789abcdefabcd";

test("browser state diagnostics starts explicitly, redacts details, and freezes", () => {
  stopBrowserStateDiagnostics();
  recordBrowserStateDiagnostic("ignored", "before-start", {
    details: { eventType: "agent_start" },
  });
  startBrowserStateDiagnostics();
  bindBrowserStateDiagnosticCaptureId("0123456789abcdef01234567");
  recordBrowserStateDiagnostic("projection", "ui-state", {
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
  const snapshot = browserStateDiagnosticSnapshot();
  assert.equal(snapshot.status.active, true);
  assert.equal(snapshot.status.captureId, "0123456789abcdef01234567");
  assert.equal(snapshot.entries.at(-1)?.sessionId, SESSION_ID);
  assert.equal(snapshot.entries.at(-1)?.runGeneration, 3);
  assert.equal(snapshot.entries.at(-1)?.details.stateStreaming, true);
  assert.equal(snapshot.entries.at(-1)?.details.eventType, "unknown");
  assert.equal(snapshot.entries.at(-1)?.details.errorType, "unknown");
  assert.equal(snapshot.entries.at(-1)?.details.longValue, undefined);
  const raw = JSON.stringify(snapshot);
  for (const forbidden of [
    "secret-token",
    "private prompt",
    "private answer",
    "C:\\\\private",
    "base64",
  ]) assert.equal(raw.includes(forbidden), false, forbidden);

  const stopped = stopBrowserStateDiagnostics();
  assert.equal(stopped.active, false);
  const count = stopped.entryCount;
  recordBrowserStateDiagnostic("ignored", "after-stop");
  assert.equal(browserStateDiagnosticStatus().entryCount, count);
});

test("diagnostic export downloads one combined versioned JSON bundle", async () => {
  const { dom } = installAppDom();
  startBrowserStateDiagnostics();
  recordBrowserStateDiagnostic("projection", "ui-state", {
    details: { stateStreaming: true },
  });
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
      schemaVersion: 1,
      generatedAt: "2026-08-14T12:00:00.000Z",
      warning: "redacted",
      server: {
        schemaVersion: 1,
        generatedAt: "2026-08-14T12:00:00.000Z",
        runEpoch: "run",
        buildRevision: "revision",
        status: {
          active: true,
          startedAt: "2026-08-14T11:59:00.000Z",
          entryCount: 0,
          windowMs: 300_000,
          maximumEntries: 2_000,
          approximateBytes: 0,
          maximumBytes: 1024 * 1024,
        },
        entries: [],
      },
      browser: browserStateDiagnosticSnapshot(),
    };
    const filename = downloadStateDiagnosticBundle(bundle);
    assert.equal(filename, "pi-chat-state-diagnostic-2026-08-14T12-00-00-000Z.json");
    assert.ok(exported);
    const parsed = JSON.parse(await exported.text()) as StateDiagnosticExportBundle;
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.browser.entries.at(-1)?.name, "ui-state");
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
    stopBrowserStateDiagnostics();
  }
});

test("starting browser diagnostics clears an older capture", () => {
  startBrowserStateDiagnostics();
  recordBrowserStateDiagnostic("first", "old");
  startBrowserStateDiagnostics();
  const snapshot = browserStateDiagnosticSnapshot();
  assert.deepEqual(snapshot.entries.map((entry) => entry.name), ["started"]);
  assert.ok(snapshot.status.approximateBytes <= snapshot.status.maximumBytes);
  stopBrowserStateDiagnostics();
});
