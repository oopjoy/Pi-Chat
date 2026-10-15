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
};

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
    for (const relative of ["modes/rpc/rpc-mode.js", "core/agent-session.js", "core/extensions/loader.js"]) {
      const path = resolve(root, relative), url = pathToFileURL(path).href;
      const bytes = await readFile(path);
      for (const source of [bytes, bytes.toString("utf8")]) {
        const loaded = { format: "module", source };
        const synchronous = hooks.loadSync(url, {}, () => loaded);
        assert.equal(synchronous instanceof Promise, false);
        assert.deepEqual(synchronous, await hooks.load(url, {}, async () => loaded));
        assert.notEqual(synchronous.source, source);
        assert.deepEqual(hooks.loadSync(url, {}, () => synchronous), synchronous);
      }
      assert.deepEqual(await readFile(path), bytes, "hooks must not edit installed Pi sources");
    }
  }
});
