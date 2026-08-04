import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { e2eRuntimeDist } from "../scripts/e2e-runtime-dist.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unable to allocate E2E port");
  server.close();
  await once(server, "close");
  return address.port;
}

async function waitForResponse(url: string, child: ReturnType<typeof spawn>): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("E2E server exited before becoming ready");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.text();
    } catch {
      // The compiled server is still starting its fake RPC.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  }
  throw new Error("E2E server did not become ready");
}

test("E2E runtime follows the staged build directory unless explicitly overridden", () => {
  assert.equal(
    e2eRuntimeDist({ PI_CHAT_DIST_DIR: ".pi-chat-stage" }, projectRoot),
    resolve(projectRoot, ".pi-chat-stage"),
  );
  assert.equal(
    e2eRuntimeDist({ PI_CHAT_DIST_DIR: ".pi-chat-stage", PI_CHAT_E2E_DIST: ".pi-chat-e2e" }, projectRoot),
    resolve(projectRoot, ".pi-chat-e2e"),
  );
  assert.equal(e2eRuntimeDist({}, projectRoot), resolve(projectRoot, "dist"));
});

test("E2E listener serves the web artifact from its staged runtime", { timeout: 30_000 }, async () => {
  const sourceDist = resolve(process.env.PI_CHAT_DIST_DIR || join(projectRoot, "dist"));
  const stagedDist = await mkdtemp(join(tmpdir(), "pi-chat-e2e-runtime-"));
  const marker = "pi-chat-e2e-staged-web-marker";
  const port = await freePort();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await cp(sourceDist, stagedDist, { recursive: true });
    const indexPath = join(stagedDist, "web", "index.html");
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, index.replace("</body>", `<meta name=\"${marker}\" content=\"${marker}\" /></body>`), "utf8");
    child = spawn(process.execPath, [join(projectRoot, "scripts", "e2e-server.mjs"), "--port", String(port)], {
      cwd: projectRoot,
      env: { ...process.env, PI_CHAT_DIST_DIR: stagedDist },
      stdio: "ignore",
      windowsHide: true,
    });
    const page = await waitForResponse(`http://127.0.0.1:${port}/`, child);
    assert.match(page, new RegExp(marker));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit").catch(() => undefined);
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
    }
    await rm(stagedDist, { recursive: true, force: true });
  }
});
