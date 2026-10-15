import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IncidentDiagnostics, IncidentFields } from "../src/server/incident-diagnostics";
import { PiRpcClient } from "../src/server/rpc-client";

test("startup milestone pipe admits only fixed codes, once per child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-startup-marks-"));
  const entry = join(root, "rpc.mjs"), probe = join(root, "probe.mjs");
  const records: IncidentFields[] = [];
  const diagnostics: IncidentDiagnostics = {
    directory: null, hostId: "test-host",
    record(fields) { records.push(fields); return { incidentId: "PC-TEST0001" }; },
    async flush() {}, async close() {},
  };
  await writeFile(probe, "// Diagnostic fd 3 requested by the client.\n");
  await writeFile(entry, String.raw`
import { writeSync } from "node:fs";
writeSync(3, "P\nA\nA\nR\nS\nS\nprivate-path-or-message\nA:99\n");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: {} }) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`);
  const client = new PiRpcClient({ cwd: root, piEntry: entry, startupProbe: probe, diagnostics });
  try {
    await client.start();
    // stdout and diagnostic fd 3 are independent pipes; readiness does not
    // guarantee that the parent has already drained the diagnostic chunk.
    const deadline = Date.now() + 5_000;
    while (!records.some(r => r.startupPhase === "runtime-initialization-end") && Date.now() < deadline)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
    const milestones = records.filter(r => r.startupPhase === "child-cli-parsed"
      || r.startupPhase === "runtime-initialization-start"
      || r.startupPhase === "runtime-initialization-end");
    assert.deepEqual(milestones.map(r => r.startupPhase), [
      "child-cli-parsed", "runtime-initialization-start", "runtime-initialization-end",
    ]);
    assert.equal(new Set(milestones.map(r => r.startupSpanId)).size, 1);
    assert.ok(milestones.every(r => r.outcome === "observed"));
    assert.doesNotMatch(JSON.stringify(records), /private-path-or-message|A:99/);
    assert.ok(records.some(r => r.startupPhase === "transport-ready"));
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});
