import assert from "node:assert/strict";
import test from "node:test";
import { buildPiChat, restartServerArgs } from "../src/server/application-restart";

test("local application build command runs without a Windows npm shim spawn error", { skip: process.platform !== "win32" }, async () => {
  await buildPiChat(process.cwd());
});

test("application handoff restarts the same Pi Chat entry with its listener and workspace arguments", () => {
  const args = restartServerArgs({
    projectRoot: "C:/work/pi-chat",
    serverEntry: "C:/work/pi-chat/dist/server/server/index.js",
    host: "127.0.0.1",
    port: 30170,
    cwd: "C:/work",
    dev: false,
  });
  assert.deepEqual(args, ["C:/work/pi-chat/dist/server/server/index.js", "--host", "127.0.0.1", "--port", "30170", "--cwd", "C:/work"]);
  assert.deepEqual(restartServerArgs({ projectRoot: "x", serverEntry: "entry", host: "::1", port: 12, cwd: "y", dev: true }).slice(-1), ["--dev"]);
});
