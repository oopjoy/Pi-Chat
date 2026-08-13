import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test as base, type TestInfo } from "@playwright/test";
import { observeOwnedProcess, terminateOwnedProcessTree } from "../scripts/e2e-process-tree.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

const maxCapturedBytesPerStream = 256 * 1024;
const maxErrorSummaryCharacters = 16 * 1024;
const childCloseTimeoutMs = 5_000;

export class BoundedStreamCapture {
  private retained = Buffer.alloc(0);
  private totalBytes = 0;
  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += buffer.length;
    if (buffer.length >= maxCapturedBytesPerStream) {
      this.retained = Buffer.from(buffer.subarray(buffer.length - maxCapturedBytesPerStream));
      return;
    }
    const overflow = this.retained.length + buffer.length - maxCapturedBytesPerStream;
    this.retained = overflow > 0 ? Buffer.concat([this.retained.subarray(overflow), buffer]) : Buffer.concat([this.retained, buffer]);
  }
  snapshot(): Buffer { return Buffer.from(this.retained); }
  metadata(): { totalBytes: number; retainedBytes: number; truncated: boolean } {
    return { totalBytes: this.totalBytes, retainedBytes: this.retained.length, truncated: this.totalBytes > this.retained.length };
  }
}

type ServerCapture = { stdout: BoundedStreamCapture; stderr: BoundedStreamCapture; spawnError?: string };
type ChildClose = ReturnType<typeof observeOwnedProcess>;

function captureServerOutput(child: ChildProcess): ServerCapture {
  const capture: ServerCapture = { stdout: new BoundedStreamCapture(), stderr: new BoundedStreamCapture() };
  child.stdout?.on("data", (chunk: Buffer | string) => capture.stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => capture.stderr.append(chunk));
  child.once("error", (error) => { capture.spawnError = error.stack || error.message; });
  return capture;
}

function errorSummary(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  const summary = error instanceof Error ? error.stack || error.message : String(error);
  return summary.length > maxErrorSummaryCharacters
    ? `${summary.slice(0, maxErrorSummaryCharacters)}
...[truncated]`
    : summary;
}

function testOutcomeIsUnexpected(testInfo: TestInfo): boolean {
  return testInfo.status !== testInfo.expectedStatus;
}

export function combinedFixtureError(primaryError: unknown, secondaryErrors: unknown[], message: string): unknown {
  const errors = primaryError === undefined ? secondaryErrors : [primaryError, ...secondaryErrors];
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, message, primaryError === undefined ? undefined : { cause: primaryError });
}

async function attachServerDiagnostics(options: {
  testInfo: TestInfo; label: string; origin: string; port: number; child: ChildProcess; capture: ServerCapture;
  runtimeDist: string; e2eTestId: string; fixtureError?: unknown; teardownErrors: unknown[];
}): Promise<void> {
  const { testInfo, label, origin, port, child, capture } = options;
  const stdoutPath = testInfo.outputPath(`${label}-stdout.log`);
  const stderrPath = testInfo.outputPath(`${label}-stderr.log`);
  const metadataPath = testInfo.outputPath(`${label}-metadata.json`);
  await Promise.all([
    writeFile(stdoutPath, capture.stdout.snapshot()),
    writeFile(stderrPath, capture.stderr.snapshot()),
    writeFile(metadataPath, `${JSON.stringify({
      origin, port, pid: child.pid ?? null, projectName: testInfo.project.name, testId: testInfo.testId,
      e2eTestId: options.e2eTestId, runtimeDist: options.runtimeDist, status: testInfo.status, expectedStatus: testInfo.expectedStatus,
      exitState: { exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed, spawnError: capture.spawnError ?? null },
      capture: { maxBytesPerStream: maxCapturedBytesPerStream, stdout: capture.stdout.metadata(), stderr: capture.stderr.metadata() },
      fixtureError: errorSummary(options.fixtureError) ?? null,
      teardownErrors: options.teardownErrors.map((error) => errorSummary(error)),
    }, null, 2)}\n`, "utf8"),
  ]);
  await Promise.all([
    testInfo.attach(`${label}-stdout`, { path: stdoutPath, contentType: "text/plain" }),
    testInfo.attach(`${label}-stderr`, { path: stderrPath, contentType: "text/plain" }),
    testInfo.attach(`${label}-metadata`, { path: metadataPath, contentType: "application/json" }),
  ]);
}

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

async function waitForChildClose(childClose: ChildClose): Promise<boolean> {
  return Promise.race([
    childClose.close.promise.then(() => true),
    new Promise<boolean>((resolveDelay) => setTimeout(() => resolveDelay(false), childCloseTimeoutMs)),
  ]);
}

async function stopServer(origin: string, child: ChildProcess, childClose: ChildClose): Promise<void> {
  if (!childClose.close.confirmed && child.exitCode === null && child.signalCode === null) {
    try {
      const handshake = await fetch(`${origin}/api/bootstrap/handshake`, { signal: AbortSignal.timeout(2_000) });
      const data = await handshake.json() as { requestToken?: string };
      if (handshake.ok && data.requestToken) {
        await fetch(`${origin}/api/shutdown`, {
          method: "POST", headers: { origin, "x-pi-chat-token": data.requestToken }, signal: AbortSignal.timeout(5_000),
        });
      }
    } catch {
      // Fall through to process-tree termination when graceful shutdown is unavailable.
    }
  }
  if (childClose.close.confirmed || await waitForChildClose(childClose)) return;
  await terminateOwnedProcessTree(childClose, childCloseTimeoutMs);
}

async function runCapturedServerFixture(options: {
  testInfo: TestInfo; label: string; port: number; runtimeDist: string; env: NodeJS.ProcessEnv;
  use: (origin: string) => Promise<void>;
}): Promise<void> {
  const origin = `http://127.0.0.1:${options.port}`;
  const e2eTestId = options.env.PI_CHAT_E2E_TEST_ID || `${options.testInfo.project.name}-${options.testInfo.testId}`;
  const child = spawn(process.execPath, [resolve(projectRoot, "scripts", "e2e-server.mjs"), "--port", String(options.port)], {
    cwd: projectRoot, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const childClose = observeOwnedProcess(child);
  const capture = captureServerOutput(child);
  let primaryError: unknown;
  const teardownErrors: unknown[] = [];
  try {
    await waitForServer(origin, child);
    await options.use(origin);
  } catch (error) {
    primaryError = error;
  }
  try {
    await stopServer(origin, child, childClose);
  } catch (error) {
    teardownErrors.push(error);
  }
  if (testOutcomeIsUnexpected(options.testInfo) && childClose.close.confirmed) {
    try {
      await attachServerDiagnostics({ testInfo: options.testInfo, label: options.label, origin, port: options.port, child, capture,
        runtimeDist: options.runtimeDist, e2eTestId, fixtureError: primaryError, teardownErrors });
    } catch (error) {
      teardownErrors.push(error);
    }
  }
  const error = combinedFixtureError(primaryError, teardownErrors, `${options.label} fixture and teardown failed`);
  if (error !== undefined) throw error;
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
    await runCapturedServerFixture({
      testInfo,
      label: "isolated-server",
      port,
      runtimeDist: runtimeDist(),
      env: { ...process.env, PI_CHAT_E2E_TEST_ID: `${testInfo.project.name}-${testInfo.testId}` },
      use,
    });
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
    let primaryError: unknown;
    try {
      await cp(join(serverDist, "web"), join(hybridDist, "web"), { recursive: true });
      await cp(join(serverDist, "build-identity.json"), join(hybridDist, "build-identity.json"));
      if (!await replaceFingerprint(join(hybridDist, "web"), identity.fingerprint, webFingerprint)) {
        throw new Error("未能在 Web artifact 中替换 build fingerprint");
      }
      const port = await freePort();
      await runCapturedServerFixture({
        testInfo, label: "mismatched-server", port, runtimeDist: hybridDist,
        env: {
          ...process.env, PI_CHAT_E2E_TEST_ID: `mismatch-${testInfo.project.name}-${testInfo.testId}`,
          PI_CHAT_E2E_DIST: hybridDist, PI_CHAT_E2E_SERVER_DIST: serverDist,
        },
        use,
      });
    } catch (error) {
      primaryError = error;
    }
    const cleanupErrors: unknown[] = [];
    try {
      await rm(hybridDist, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    const error = combinedFixtureError(primaryError, cleanupErrors, "mismatched-server fixture and temporary dist cleanup failed");
    if (error !== undefined) throw error;
  },
});

export { expect };
