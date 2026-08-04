import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const guard = resolve(root, "scripts", "assert-safe-live-dist.mjs");

async function runGuard(port: number, distDir?: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [guard], {
    cwd: root,
    env: { ...process.env, PI_CHAT_PORT: String(port), PI_CHAT_DIST_DIR: distDir || "" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const [code] = await once(child, "exit") as [number | null];
  return { code, stderr };
}

test("direct builds refuse to replace dist served by a live Pi Chat listener", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      service: "pi-chat",
      buildIdentity: { fingerprint: "a".repeat(64) },
    }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runGuard(address.port);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /拒绝直接覆盖正在运行的 Pi Chat dist/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("staged builds never inspect or block the live Pi Chat listener", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, service: "pi-chat", buildIdentity: { fingerprint: "a".repeat(64) } }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const staged = resolve(root, ".pi-chat-build-guard-test-staged");
  try {
    const result = await runGuard(address.port, staged);
    assert.equal(result.code, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});
