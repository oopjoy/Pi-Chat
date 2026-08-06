import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test as base } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");

function runtimeDist(): string {
  return resolve(process.env.PI_CHAT_E2E_DIST || process.env.PI_CHAT_DIST_DIR || join(projectRoot, "dist"));
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法为 E2E 测试分配端口");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForServer(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("E2E 服务在启动完成前退出");
    try {
      const response = await fetch(`${origin}/api/bootstrap/handshake`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The server is still binding or probing the fake RPC.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  }
  throw new Error("E2E 服务启动超时");
}

async function stopServer(origin: string, child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => undefined);
  try {
    const handshake = await fetch(`${origin}/api/bootstrap/handshake`, { signal: AbortSignal.timeout(2_000) });
    const data = await handshake.json() as { requestToken?: string };
    if (handshake.ok && data.requestToken) {
      await fetch(`${origin}/api/shutdown`, {
        method: "POST",
        headers: { origin, "x-pi-chat-token": data.requestToken },
        signal: AbortSignal.timeout(5_000),
      });
    }
  } catch {
    // Fall through to process-tree termination when graceful shutdown is unavailable.
  }
  if (await Promise.race([exited.then(() => true), new Promise<boolean>((resolveDelay) => setTimeout(() => resolveDelay(false), 5_000))])) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolveKill) => {
      const killer = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `taskkill /PID ${child.pid} /T /F`], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolveKill());
      killer.once("exit", () => resolveKill());
    });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
}

async function replaceFingerprint(root: string, from: string, to: string): Promise<number> {
  let replacements = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      replacements += await replaceFingerprint(path, from, to);
      continue;
    }
    if (!entry.isFile() || !/\.(?:html|js|css)$/i.test(entry.name)) continue;
    const source = await readFile(path, "utf8");
    const count = source.split(from).length - 1;
    if (!count) continue;
    await writeFile(path, source.replaceAll(from, to), "utf8");
    replacements += count;
  }
  return replacements;
}

export const test = base.extend<{ isolatedBaseURL: string; mismatchedBaseURL: string }>({
  isolatedBaseURL: [async ({}, use, testInfo) => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [resolve(projectRoot, "scripts", "e2e-server.mjs"), "--port", String(port)], {
      cwd: projectRoot,
      env: { ...process.env, PI_CHAT_E2E_TEST_ID: `${testInfo.project.name}-${testInfo.testId}` },
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await waitForServer(origin, child);
      await use(origin);
    } finally {
      await stopServer(origin, child);
    }
  }, { auto: true }],
  baseURL: async ({ isolatedBaseURL }, use) => {
    await use(isolatedBaseURL);
  },
  mismatchedBaseURL: async ({}, use, testInfo) => {
    const serverDist = runtimeDist();
    const identity = JSON.parse(await readFile(join(serverDist, "build-identity.json"), "utf8")) as { fingerprint: string };
    if (!/^[a-f0-9]{64}$/.test(identity.fingerprint)) throw new Error("E2E runtime build fingerprint 无效");
    const webFingerprint = `${identity.fingerprint[0] === "0" ? "1" : "0"}${identity.fingerprint.slice(1)}`;
    const hybridDist = await mkdtemp(join(tmpdir(), "pi-chat-e2e-mismatch-"));
    await cp(join(serverDist, "web"), join(hybridDist, "web"), { recursive: true });
    await cp(join(serverDist, "build-identity.json"), join(hybridDist, "build-identity.json"));
    if (!await replaceFingerprint(join(hybridDist, "web"), identity.fingerprint, webFingerprint)) {
      await rm(hybridDist, { recursive: true, force: true });
      throw new Error("未能在 Web artifact 中替换 build fingerprint");
    }

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [resolve(projectRoot, "scripts", "e2e-server.mjs"), "--port", String(port)], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PI_CHAT_E2E_TEST_ID: `mismatch-${testInfo.project.name}-${testInfo.testId}`,
        PI_CHAT_E2E_DIST: hybridDist,
        PI_CHAT_E2E_SERVER_DIST: serverDist,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await waitForServer(origin, child);
      await use(origin);
    } finally {
      await stopServer(origin, child);
      await rm(hybridDist, { recursive: true, force: true });
    }
  },
});

export { expect };
