import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PiRpcClient, rpcData } from "../src/server/rpc-client";
import { pinnedPiEntry } from "./helpers/pinned-pi";

const overlayUrl = new URL("../resources/runtime/pi-chat-rpc-loader.mjs", import.meta.url).href;

test("Pi Chat adds native dequeue only inside its RPC child", async () => {
  const piEntry = pinnedPiEntry;
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
  assert.match(patched, /case "pi_chat_refresh_models"/);
  assert.match(patched, /session\.modelRuntime\.refresh/);
  assert.equal(overlay.patchPiRpcModeSource(patched), patched);
  assert.equal(original.includes('case "pi_chat_refresh_models"'), false);

  const unchanged = await readFile(rpcModePath, "utf8");
  assert.equal(unchanged, original, "the global Pi installation must remain untouched");
});

test("the dequeue overlay accepts Pi RPC follow-up signatures before and after source attribution", async () => {
  const overlay = await import(overlayUrl) as {
    patchPiRpcModeSource(source: string): string;
  };
  const signatures = [
    "                await session.followUp(command.message, command.images);",
    '                await session.followUp(command.message, command.images, { source: "rpc" });',
    '                const disposition = await session.followUp(command.message, command.images, { source: "rpc" });\n                return success(id, "follow_up", { disposition });',
  ];

  for (const followUp of signatures) {
    const source = `            case "follow_up": {\n${followUp}\n                return success(id, "follow_up");\n            }\n            case "abort": {`;
    const patched = overlay.patchPiRpcModeSource(source);
    assert.match(patched, /case "dequeue"/);
    assert.ok(patched.includes(followUp));
    assert.equal(overlay.patchPiRpcModeSource(patched), patched);
  }
});

test("a real Pi RPC child accepts the process-local native dequeue command", { timeout: 75_000 }, async () => {
  const piEntry = pinnedPiEntry;
  assert.ok(piEntry);
  const rpcRegister = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "resources",
    "runtime",
    "pi-chat-rpc-register.mjs",
  );
  const sandbox = await mkdtemp(join(tmpdir(), "pi-chat-dequeue-overlay-"));
  const client = new PiRpcClient({
    cwd: sandbox,
    childEnvironment: { PI_CODING_AGENT_DIR: sandbox, PI_CODING_AGENT_SESSION_DIR: join(sandbox, "sessions"), HOME: sandbox, USERPROFILE: sandbox },
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
    await rm(sandbox, { recursive: true, force: true });
  }
});
