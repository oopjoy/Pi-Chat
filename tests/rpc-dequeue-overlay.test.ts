import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PiRpcClient, resolvePiEntry, rpcData } from "../src/server/rpc-client";

const overlayUrl = new URL("../resources/runtime/pi-chat-rpc-loader.mjs", import.meta.url).href;

test("Pi Chat adds native dequeue only inside its RPC child", { skip: !resolvePiEntry() }, async () => {
  const piEntry = resolvePiEntry();
  assert.ok(piEntry, "global Pi RPC entry must be discoverable");
  const rpcModePath = resolve(dirname(piEntry), "modes", "rpc", "rpc-mode.js");
  const original = await readFile(rpcModePath, "utf8");
  assert.equal(original.includes('case "dequeue"'), false);

  const overlay = await import(overlayUrl) as {
    patchPiRpcModeSource(source: string): string;
  };
  const patched = overlay.patchPiRpcModeSource(original);
  assert.match(patched, /case "dequeue"/);
  assert.match(patched, /session\.clearQueue\(\)/);
  assert.match(patched, /type: "pi_chat_queue_dequeued"/);
  assert.equal(overlay.patchPiRpcModeSource(patched), patched);

  const unchanged = await readFile(rpcModePath, "utf8");
  assert.equal(unchanged, original, "the global Pi installation must remain untouched");
});

test("a real Pi RPC child accepts the process-local native dequeue command", { skip: !resolvePiEntry(), timeout: 75_000 }, async () => {
  const piEntry = resolvePiEntry();
  assert.ok(piEntry);
  const rpcRegister = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "resources",
    "runtime",
    "pi-chat-rpc-register.mjs",
  );
  const client = new PiRpcClient({
    cwd: process.cwd(),
    piEntry,
    rpcRegister,
    args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
  });
  const events: Record<string, unknown>[] = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.start();
    const result = rpcData<{ steering: string[]; followUp: string[] }>(
      await client.send({
        type: "dequeue",
        dequeueId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    assert.deepEqual(result, { steering: [], followUp: [] });
    assert.ok(events.some((event) =>
      event.type === "pi_chat_queue_dequeued" &&
      event.dequeueId === "33333333-3333-4333-8333-333333333333",
    ));
  } finally {
    await client.stop();
  }
});
