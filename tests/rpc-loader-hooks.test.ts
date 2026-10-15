import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolvePiEntry } from "../src/server/rpc-client";

type Loaded = { format: string; source: string | Buffer | null };
const hooks = await import(new URL("../resources/runtime/pi-chat-rpc-loader.mjs", import.meta.url).href) as {
  load(url: string, context: unknown, next: () => Promise<Loaded>): Promise<Loaded>;
  loadSync(url: string, context: unknown, next: () => Loaded): Loaded;
  patchPiStartupMilestones(source: string): string;
};

test("startup milestones preserve execution and fail open for unknown Pi shapes or broken telemetry", () => {
  const source = 'time("parseArgs"); time("createRuntime"); time("createAgentSessionRuntime");';
  const patched = hooks.patchPiStartupMilestones(source);
  const originalCalls: string[] = [], calls: string[] = [], markers: string[] = [];
  new Function("time", "globalThis", source)((label: string) => originalCalls.push(label), {});
  new Function("time", "globalThis", patched)((label: string) => calls.push(label), {
    __piChatStartupMark: (marker: string) => markers.push(marker),
  });
  assert.deepEqual(calls, originalCalls);
  assert.deepEqual(markers, ["A", "R", "S"]);
  assert.equal(hooks.patchPiStartupMilestones(patched), patched);
  assert.doesNotThrow(() => new Function("time", "globalThis", patched)(() => {}, {}));
  assert.doesNotThrow(() => new Function("time", "globalThis", patched)(() => {}, {
    __piChatStartupMark() { throw new Error("telemetry unavailable"); },
  }));
  for (const unknown of ['', 'time("parseArgs");', source + 'time("parseArgs");'])
    assert.equal(hooks.patchPiStartupMilestones(unknown), unknown);
});

test("sync and async Runtime hooks keep unrelated modules unchanged and preserve loader errors", async () => {
  const original = { format: "module", source: "export const untouched = true;" };
  const url = "file:///test/unrelated.js";
  assert.equal(hooks.loadSync(url, {}, () => original), original);
  assert.equal(await hooks.load(url, {}, async () => original), original);
  assert.throws(() => hooks.loadSync(url, {}, () => { throw new Error("fixture-read-failed"); }), /fixture-read-failed/);
  await assert.rejects(hooks.load(url, {}, async () => { throw new Error("fixture-read-failed"); }), /fixture-read-failed/);
  const missing = { format: "module", source: null };
  assert.equal(hooks.loadSync("file:///test/dist/core/agent-session.js", {}, () => missing), missing);
});

test("synchronous Runtime hooks apply exactly the same dequeue, receipt and extension patches", async () => {
  const roots = [resolve("node_modules/@earendil-works/pi-coding-agent/dist")];
  const global = resolvePiEntry();
  if (global) roots.push(dirname(global));
  for (const root of roots) {
    for (const relative of ["modes/rpc/rpc-mode.js", "core/agent-session.js", "core/extensions/loader.js", "main.js"]) {
      const path = resolve(root, relative), url = pathToFileURL(path).href;
      const bytes = await readFile(path);
      for (const source of [bytes, bytes.toString("utf8")]) {
        const loaded = { format: "module", source };
        const synchronous = hooks.loadSync(url, {}, () => loaded);
        assert.equal(synchronous instanceof Promise, false);
        assert.deepEqual(synchronous, await hooks.load(url, {}, async () => loaded));
        if (relative !== "main.js") assert.notEqual(synchronous.source, source);
        else assert.equal(synchronous.source, hooks.patchPiStartupMilestones(bytes.toString("utf8")));
        assert.deepEqual(hooks.loadSync(url, {}, () => synchronous), synchronous);
      }
      assert.deepEqual(await readFile(path), bytes, "hooks must not edit installed Pi sources");
    }
  }
});
