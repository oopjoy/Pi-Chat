import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { e2eRuntimeDist } from "../scripts/e2e-runtime-dist.mjs";
import {
  observeOwnedProcess,
  terminateOwnedProcessTreeForCleanup,
} from "../scripts/e2e-process-tree.mjs";
import {
  combinedE2eError,
  removeE2eRootAfterConfirmedTree,
} from "../scripts/e2e-root.mjs";

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

test("E2E listener serves its staged web artifact and isolates incident logs from the parent", { timeout: 30_000 }, async () => {
  const sourceDist = resolve(process.env.PI_CHAT_DIST_DIR || join(projectRoot, "dist"));
  const stagedDist = await mkdtemp(join(tmpdir(), "pi-chat-e2e-runtime-"));
  const serverRoot = await mkdtemp(join(tmpdir(), "pi-chat-e2e-root-"));
  const marker = "pi-chat-e2e-staged-web-marker";
  const port = await freePort();
  let child: ReturnType<typeof spawn> | undefined;
  let observed: ReturnType<typeof observeOwnedProcess> | undefined;
  let primaryError: unknown;
  try {
    await cp(sourceDist, stagedDist, { recursive: true });
    const indexPath = join(stagedDist, "web", "index.html");
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, index.replace("</body>", `<meta name=\"${marker}\" content=\"${marker}\" /></body>`), "utf8");
    const parentState = join(stagedDist, "parent-state");
    const logTail = process.platform === "win32" ? ["Pi Chat", "diagnostics"] : ["pi-chat", "diagnostics"];
    const parentLog = join(parentState, ...logTail, "incidents.jsonl");
    await mkdir(join(parentState, ...logTail), { recursive: true });
    await writeFile(parentLog, "parent-log-sentinel\n");
    child = spawn(process.execPath, [
      join(projectRoot, "scripts", "e2e-server.mjs"),
      "--port",
      String(port),
      "--root",
      serverRoot,
    ], {
      cwd: projectRoot,
      env: { ...process.env, PI_CHAT_DIST_DIR: stagedDist, LOCALAPPDATA: parentState, XDG_STATE_HOME: parentState },
      stdio: "ignore",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    observed = observeOwnedProcess(child, process.platform !== "win32");
    const page = await waitForResponse(`http://127.0.0.1:${port}/`, child);
    assert.match(page, new RegExp(marker));
    const ownedLog = join(serverRoot, process.platform === "win32" ? "local-appdata" : "state", ...logTail, "incidents.jsonl");
    let records = "";
    for (let attempt = 0; attempt < 50 && !records.includes('"host.start"'); attempt++) {
      try { records = await readFile(ownedLog, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!records.includes('"host.start"')) await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
    }
    assert.match(records, /"host.start"/);
    assert.equal(await readFile(parentLog, "utf8"), "parent-log-sentinel\n");
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  let treeExitConfirmed = observed === undefined;
  if (observed) {
    try {
      await terminateOwnedProcessTreeForCleanup(observed, 5_000);
      treeExitConfirmed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const root of [serverRoot, stagedDist]) {
    try {
      await removeE2eRootAfterConfirmedTree(root, treeExitConfirmed);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const failure = combinedE2eError(
    primaryError,
    cleanupErrors,
    "E2E staged-runtime assertion and cleanup failed",
  );
  if (failure !== undefined) throw failure;
});
