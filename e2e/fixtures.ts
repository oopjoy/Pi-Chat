import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { expect, test as base } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");

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

export const test = base.extend<{ isolatedBaseURL: string }>({
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
});

export { expect };
