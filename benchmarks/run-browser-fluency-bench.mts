import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  observeOwnedProcess,
  terminateOwnedProcessTreeForCleanup,
} from "../scripts/e2e-process-tree.mjs";
import {
  combinedE2eError,
  removeE2eRootAfterConfirmedTree,
} from "../scripts/e2e-root.mjs";
import { generateFixture, type FixtureManifest } from "./long-session-fixtures.mjs";
import {
  aggregateBrowserFluency,
  publicFixtureMetadata,
  type BrowserFluencySample,
} from "./lib/browser-fluency.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const LIVE_PORT = 30_170;
const VIEWPORT = { width: 1_360, height: 900 };
const ACTION_TIMEOUT_MS = 30_000;
const SERVER_START_TIMEOUT_MS = 25_000;
const SERVER_CLOSE_TIMEOUT_MS = 10_000;
const MAX_CAPTURED_CHILD_CHARACTERS = 128 * 1024;

type BuildIdentity = {
  schemaVersion: 1;
  packageVersion: string;
  revision: string;
  fingerprint: string;
  builtAt: string;
};

type ImportedSession = { name: string; id: string };
type ImportedManifest = { sessions: ImportedSession[] };

type BrowserFixture = {
  fileName: string;
  title: string;
  manifest: FixtureManifest;
};

type ObservedOwnedProcess = {
  child: ChildProcess;
  close: { confirmed: boolean; promise: Promise<void> };
  processGroup: boolean;
};

type RunningServer = ObservedOwnedProcess & {
  origin: string;
  manifestPath: string;
  serverRoot: string;
  stdout: () => string;
  stderr: () => string;
};

export interface BrowserFluencyResult {
  schemaVersion: 1;
  benchmark: "pi-chat-browser-fluency";
  generatedAt: string;
  baselinePolicy: "descriptive-only";
  environment: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    chromiumVersion: string;
    headless: true;
    viewport: typeof VIEWPORT;
  };
  isolation: {
    stagingBuild: BuildIdentity;
    freshBenchmarkServerPerIteration: true;
    freshBrowserContextPerIteration: true;
    browserProcessReusedAcrossIterations: true;
    generatedTemporaryFixturesOnly: true;
    loopbackEphemeralPortNever30170: true;
  };
  fixtures: Array<ReturnType<typeof publicFixtureMetadata> & { logicalName: string }>;
  iterations: number;
  metrics: Record<string, string>;
  samples: BrowserFluencySample[];
  summaries: ReturnType<typeof aggregateBrowserFluency>;
  thresholds: null;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function requiredFile(path: string): Promise<void> {
  await access(path).catch(() => {
    throw new Error(`Staging dist is missing required artifact: ${path}`);
  });
}

export async function validateStagingDist(input: string): Promise<{ root: string; identity: BuildIdentity }> {
  if (!input) throw new Error("--dist is required and must point to a staging dist");
  const requestedRoot = resolve(input);
  const liveDistCandidate = resolve(projectRoot, "dist");
  // Reject the repository-owned live target by identity before probing whether
  // it currently exists. A clean worktree may have no dist yet, but that must
  // not weaken the benchmark's explicit staging-only contract.
  if (samePath(requestedRoot, liveDistCandidate))
    throw new Error("Browser fluency benchmark refuses the repository live dist; provide an explicit staging dist");
  const root = await realpath(requestedRoot).catch(() => {
    throw new Error(`Staging dist does not exist: ${requestedRoot}`);
  });
  const liveDist = await realpath(liveDistCandidate).catch(() => liveDistCandidate);
  if (samePath(root, liveDist))
    throw new Error("Browser fluency benchmark refuses the repository live dist; provide an explicit staging dist");
  await Promise.all([
    requiredFile(join(root, "build-identity.json")),
    requiredFile(join(root, "web", "index.html")),
    requiredFile(join(root, "server", "server", "index.js")),
  ]);
  const identity = JSON.parse(await readFile(join(root, "build-identity.json"), "utf8")) as BuildIdentity;
  if (
    identity.schemaVersion !== 1 ||
    typeof identity.packageVersion !== "string" ||
    typeof identity.revision !== "string" ||
    !/^[a-f0-9]{64}$/i.test(identity.fingerprint) ||
    typeof identity.builtAt !== "string"
  ) throw new Error("Staging dist build identity is invalid");
  return { root, identity };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a benchmark port");
  const port = address.port;
  server.close();
  await once(server, "close");
  if (port === LIVE_PORT) return freePort();
  return port;
}

function captureTail(child: ChildProcess, stream: "stdout" | "stderr"): () => string {
  let retained = "";
  child[stream]?.on("data", (chunk: Buffer | string) => {
    retained += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (retained.length > MAX_CAPTURED_CHILD_CHARACTERS)
      retained = retained.slice(-MAX_CAPTURED_CHILD_CHARACTERS);
  });
  return () => retained;
}

export function benchmarkChildEnvironment(options: {
  stagingDist: string;
  fixtureDirectory: string;
  manifestPath: string;
  stateDirectory: string;
}, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  delete environment.PI_CHAT_DIST_DIR;
  delete environment.PI_CHAT_RUNTIME_DIST;
  delete environment.PI_CODING_AGENT_SESSION_DIR;
  delete environment.PI_CHAT_E2E_IMPORT_FIXTURES;
  delete environment.PI_CHAT_E2E_FIXTURE_DIR;
  delete environment.PI_CHAT_E2E_MANIFEST_PATH;
  environment.PI_CHAT_E2E_DIST = options.stagingDist;
  environment.PI_CHAT_E2E_SERVER_DIST = options.stagingDist;
  environment.XDG_STATE_HOME = join(options.stateDirectory, "xdg-state");
  environment.LOCALAPPDATA = join(options.stateDirectory, "local-app-data");
  return environment;
}

async function waitForServer(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Benchmark server exited before readiness");
    try {
      const response = await fetch(`${origin}/api/bootstrap/handshake`, {
        cache: "no-store",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The disposable server is still binding or preparing its fake RPC.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  }
  throw new Error("Benchmark server readiness timed out");
}

async function startServer(options: {
  stagingDist: string;
  fixtureDirectory: string;
  stateDirectory: string;
  manifestPath: string;
}): Promise<RunningServer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const port = await freePort();
    if (port === LIVE_PORT) continue;
    const origin = `http://127.0.0.1:${port}`;
    const serverRoot = await mkdtemp(join(tmpdir(), "pi-chat-e2e-root-"));
    const child = spawn(
      process.execPath,
      [
        resolve(projectRoot, "scripts", "e2e-server.mjs"),
        "--port",
        String(port),
        "--fixture-dir",
        options.fixtureDirectory,
        "--fixture-manifest",
        options.manifestPath,
        "--root",
        serverRoot,
      ],
      {
        cwd: projectRoot,
        env: benchmarkChildEnvironment(options),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    const observed = observeOwnedProcess(child, process.platform !== "win32");
    const stdout = captureTail(child, "stdout");
    const stderr = captureTail(child, "stderr");
    try {
      await waitForServer(origin, child);
      return { ...observed, origin, manifestPath: options.manifestPath, serverRoot, stdout, stderr };
    } catch (error) {
      lastError = error;
      const cleanupErrors: unknown[] = [];
      let treeExitConfirmed = false;
      try {
        await terminateOwnedProcessTreeForCleanup(observed);
        treeExitConfirmed = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await removeE2eRootAfterConfirmedTree(serverRoot, treeExitConfirmed);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      const failure = combinedE2eError(
        error,
        cleanupErrors,
        `Benchmark server startup and teardown failed; retained root: ${serverRoot}`,
      );
      if (cleanupErrors.length || !/EADDRINUSE/i.test(stderr()))
        throw failure;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function stopServer(server: RunningServer): Promise<void> {
  await terminateOwnedProcessTreeForCleanup(server, SERVER_CLOSE_TIMEOUT_MS);
}

async function importedSessions(path: string): Promise<ImportedManifest> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as ImportedManifest;
  if (!Array.isArray(manifest.sessions)) throw new Error("Benchmark server fixture manifest is invalid");
  return manifest;
}

async function waitForTwoFrames(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolveFrames) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveFrames(performance.now())));
  }));
}

async function installActionProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as Window & {
      __piChatBrowserBench?: {
        start: number;
        longTasksSupported: boolean;
        longTasks: Array<{ startTime: number; duration: number }>;
      };
      __piChatBrowserBenchObserver?: PerformanceObserver;
    };
    state.__piChatBrowserBenchObserver?.disconnect();
    const entries: Array<{ startTime: number; duration: number }> = [];
    let supported = false;
    try {
      const supportedEntryTypes = PerformanceObserver.supportedEntryTypes || [];
      supported = supportedEntryTypes.includes("longtask");
      if (supported) {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            entries.push({ startTime: entry.startTime, duration: entry.duration });
        });
        observer.observe({ type: "longtask", buffered: false });
        state.__piChatBrowserBenchObserver = observer;
      }
    } catch {
      supported = false;
    }
    state.__piChatBrowserBench = {
      start: performance.now(),
      longTasksSupported: supported,
      longTasks: entries,
    };
  });
}

async function heapBytes(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
  });
}

async function installBrowserActionHarness(page: Page): Promise<void> {
  const source = `(() => {
    const timeoutMs = ${ACTION_TIMEOUT_MS};
    const harness = {
      active: null,
      settle(payload) {
        const active = this.active;
        if (!active) return;
        this.active = null;
        clearTimeout(active.timeout);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          active.resolve({ ...payload, settledAt: performance.now() });
        }));
      },
      fail(message) {
        const active = this.active;
        if (!active) return;
        this.active = null;
        clearTimeout(active.timeout);
        active.reject(new Error(message));
      },
      begin(kind, details, target) {
        if (this.active) this.fail("A browser benchmark action was replaced before settlement");
        const benchmark = window.__piChatBrowserBench;
        if (!benchmark) return Promise.reject(new Error("Browser benchmark action probe is unavailable"));
        return new Promise((resolve, reject) => {
          this.active = {
            kind,
            details,
            resolve,
            reject,
            timeout: setTimeout(() => this.fail(kind + " action timed out"), timeoutMs),
          };
          benchmark.start = performance.now();
          target.click();
        });
      },
      session(target, details) {
        return this.begin("session", details, target);
      },
      loadEarlier(target, details) {
        return this.begin("load-earlier", details, target);
      },
    };
    window.__piChatBrowserActionHarness = harness;
    window.addEventListener("pi-chat:pane-first-commit", (event) => {
      const active = harness.active;
      if (!active || active.kind !== "session") return;
      if (event.detail?.sessionId !== active.details.sessionId || event.detail?.source !== active.details.source) return;
      harness.settle({ paneCommitMs: Number(event.detail?.elapsedMs) });
    });
    const inspect = () => {
      const active = harness.active;
      if (active?.kind === "load-earlier") {
        const notice = document.querySelector(".message-window-notice")?.textContent || "";
        const match = Array.from(document.querySelectorAll(".message-user")).find((element) =>
          element.innerText === active.details.anchorText,
        );
        if (notice !== active.details.previousNotice && match)
          harness.settle({ anchorTop: match.getBoundingClientRect().top });
      }
      requestAnimationFrame(inspect);
    };
    requestAnimationFrame(inspect);
  })();`;
  await page.evaluate(source);
}

async function measureSessionAction(page: Page, title: string, sessionId: string, source: "cold-jsonl" | "browser-cache") {
  return sessionButton(page, title).evaluate((target, expected) => {
    const harness = (window as Window & {
      __piChatBrowserActionHarness?: {
        session: (element: Element, details: typeof expected) => Promise<{ paneCommitMs: number; settledAt: number }>;
      };
    }).__piChatBrowserActionHarness;
    if (!harness) throw new Error("Browser action harness is unavailable");
    return harness.session(target, expected);
  }, { sessionId, source });
}

async function measureLoadEarlierAction(page: Page, anchorText: string, previousNotice: string) {
  const expected = { anchorText, previousNotice };
  return page.getByRole("button", { name: "加载更早 10 轮" }).evaluate((target, details) => {
    const harness = (window as Window & {
      __piChatBrowserActionHarness?: {
        loadEarlier: (element: Element, value: typeof details) => Promise<{ anchorTop: number; settledAt: number }>;
      };
    }).__piChatBrowserActionHarness;
    if (!harness) throw new Error("Browser action harness is unavailable");
    return harness.loadEarlier(target, details);
  }, expected);
}

async function finishSample(options: {
  page: Page;
  iteration: number;
  scenario: BrowserFluencySample["scenario"];
  fixture: string;
  source: BrowserFluencySample["source"];
  paneCommitMs: number | null;
  heapBefore: number | null;
  anchorErrorCssPx?: number | null;
  settledAt?: number;
}): Promise<BrowserFluencySample> {
  const settledAt = options.settledAt ?? await waitForTwoFrames(options.page);
  const input = {
    iteration: options.iteration,
    scenario: options.scenario,
    fixture: options.fixture,
    source: options.source,
    paneCommitMs: options.paneCommitMs,
    heapBefore: options.heapBefore,
    anchorErrorCssPx: options.anchorErrorCssPx ?? null,
    settledAt,
  };
  return options.page.evaluate((input) => {
    const benchmarkWindow = window as Window & {
      __piChatBrowserBench?: {
        start: number;
        longTasksSupported: boolean;
        longTasks: Array<{ startTime: number; duration: number }>;
      };
      __piChatBrowserBenchObserver?: PerformanceObserver;
    };
    const state = benchmarkWindow.__piChatBrowserBench;
    if (!state) throw new Error("Browser benchmark action probe is unavailable");
    for (const entry of benchmarkWindow.__piChatBrowserBenchObserver?.takeRecords() || [])
      state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    const selected = state.longTasks.filter((entry) =>
      entry.startTime <= input.settledAt && entry.startTime + entry.duration >= state.start,
    );
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    const heapAfter = typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
    const heapSupported = input.heapBefore !== null && heapAfter !== null;
    const anchorError = input.anchorErrorCssPx ?? null;
    return {
      iteration: input.iteration,
      scenario: input.scenario,
      fixture: input.fixture,
      source: input.source,
      actionToSettledFrameMs: Math.round((input.settledAt - state.start) * 1_000) / 1_000,
      paneCommitMs: input.paneCommitMs,
      domNodeCount: document.getElementsByTagName("*").length,
      longTasks: {
        supported: state.longTasksSupported,
        count: state.longTasksSupported ? selected.length : null,
        totalDurationMs: state.longTasksSupported
          ? Math.round(selected.reduce((total, entry) => total + entry.duration, 0) * 1_000) / 1_000
          : null,
        maxDurationMs: state.longTasksSupported
          ? Math.round(Math.max(0, ...selected.map((entry) => entry.duration)) * 1_000) / 1_000
          : null,
      },
      heap: {
        supported: heapSupported,
        collectionApi: heapSupported ? "performance.memory" : null,
        beforeBytes: input.heapBefore,
        afterBytes: heapAfter,
        deltaBytes: heapSupported ? heapAfter - input.heapBefore : null,
      },
      anchorErrorCssPx: anchorError,
      anchorAbsoluteErrorCssPx: anchorError === null ? null : Math.abs(anchorError),
    };
  }, input);
}

function sessionButton(page: Page, title: string) {
  return page.locator(".session-item", { hasText: title });
}

async function exposeSession(page: Page, title: string): Promise<void> {
  const search = page.getByRole("searchbox", { name: "搜索对话" });
  await search.fill(title);
  const row = sessionButton(page, title);
  try {
    await row.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    const syntheticDirectory = page.locator(".session-directory", { hasText: "/pi-chat-benchmark/fixture-workspace" });
    const toggle = syntheticDirectory.locator(".session-directory-toggle");
    await toggle.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await row.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  }
}

async function measureIteration(options: {
  browser: Browser;
  stagingDist: string;
  root: string;
  iteration: number;
  fixtures: BrowserFixture[];
}): Promise<BrowserFluencySample[]> {
  const iterationRoot = join(options.root, `iteration-${options.iteration}`);
  const stateDirectory = join(iterationRoot, "state");
  const manifestPath = join(iterationRoot, "imported-fixtures.json");
  await mkdir(stateDirectory, { recursive: true });
  const server = await startServer({
    stagingDist: options.stagingDist,
    fixtureDirectory: join(options.root, "fixtures"),
    stateDirectory,
    manifestPath,
  });
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  let primaryError: unknown;
  try {
    const imported = await importedSessions(server.manifestPath);
    const sessionByName = new Map(imported.sessions.map((session) => [session.name, session.id]));
    for (const fixture of options.fixtures) {
      if (!sessionByName.has(fixture.fileName))
        throw new Error(`Benchmark server did not import ${fixture.fileName}`);
    }
    const longTurns = options.fixtures.find((fixture) => fixture.fileName === "bench-thousand-turns.jsonl")!;
    const longTurnsId = sessionByName.get(longTurns.fileName)!;

    context = await options.browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await page.goto(server.origin, { waitUntil: "domcontentloaded" });
    await page.getByText("First answer", { exact: true }).waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    await installBrowserActionHarness(page);
    await exposeSession(page, longTurns.title);

    const samples: BrowserFluencySample[] = [];

    await installActionProbe(page);
    const coldHeapBefore = await heapBytes(page);
    const coldCommit = await measureSessionAction(page, longTurns.title, longTurnsId, "cold-jsonl");
    samples.push(await finishSample({
      page,
      iteration: options.iteration,
      scenario: "cold-first-pane",
      fixture: longTurns.fileName,
      source: "cold-jsonl",
      paneCommitMs: round(coldCommit.paneCommitMs),
      heapBefore: coldHeapBefore,
      settledAt: coldCommit.settledAt,
    }));

    await exposeSession(page, "First session");
    await sessionButton(page, "First session").click();
    await page.getByText("First answer", { exact: true }).waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    await exposeSession(page, longTurns.title);
    await installActionProbe(page);
    const hotHeapBefore = await heapBytes(page);
    const hotCommit = await measureSessionAction(page, longTurns.title, longTurnsId, "browser-cache");
    samples.push(await finishSample({
      page,
      iteration: options.iteration,
      scenario: "hot-switch",
      fixture: longTurns.fileName,
      source: "browser-cache",
      paneCommitMs: round(hotCommit.paneCommitMs),
      heapBefore: hotHeapBefore,
      settledAt: hotCommit.settledAt,
    }));

    const loadButton = page.getByRole("button", { name: "加载更早 10 轮" });
    await loadButton.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    const anchorBefore = await page.evaluate(() => {
      const timeline = document.querySelector<HTMLElement>(".timeline");
      if (!timeline) return null;
      const viewport = timeline.getBoundingClientRect();
      const candidate = Array.from(document.querySelectorAll<HTMLElement>(".message-user")).find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > viewport.top + 8 && rect.top < viewport.bottom - 8;
      });
      return candidate ? { text: candidate.innerText, top: candidate.getBoundingClientRect().top } : null;
    });
    if (!anchorBefore) throw new Error("Load-earlier benchmark could not select a visible pre-existing anchor");
    const anchorText = anchorBefore.text;
    const anchor = page.locator(".message-user").filter({ hasText: anchorText }).first();
    const beforeAnchorTop = anchorBefore.top;
    const visibleTurnsBefore = await page.locator(".message-window-notice").innerText();
    await installActionProbe(page);
    const earlierHeapBefore = await heapBytes(page);
    const earlierCommit = await measureLoadEarlierAction(page, anchorText, visibleTurnsBefore);
    const afterAnchorTop = earlierCommit.anchorTop;
    samples.push(await finishSample({
      page,
      iteration: options.iteration,
      scenario: "load-earlier",
      fixture: longTurns.fileName,
      source: "history-window",
      paneCommitMs: null,
      heapBefore: earlierHeapBefore,
      anchorErrorCssPx: round(afterAnchorTop - beforeAnchorTop),
      settledAt: earlierCommit.settledAt,
    }));

    return samples;
  } catch (error) {
    const details = [
      error instanceof Error ? error.stack || error.message : String(error),
      server.stdout() ? `server stdout:\n${server.stdout()}` : "",
      server.stderr() ? `server stderr:\n${server.stderr()}` : "",
    ].filter(Boolean).join("\n\n");
    primaryError = new Error(details);
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await context?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    let treeExitConfirmed = false;
    try {
      await stopServer(server);
      treeExitConfirmed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await removeE2eRootAfterConfirmedTree(
        server.serverRoot,
        treeExitConfirmed,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    const failure = combinedE2eError(
      primaryError,
      cleanupErrors,
      `Benchmark iteration and teardown failed; retained root: ${iterationRoot}`,
    );
    if (failure !== undefined) throw failure;
  }
  throw new Error("Benchmark iteration ended without samples or an error");
}

export const BROWSER_FLUENCY_FIXTURE_SCENARIO = "thousand-user-turns" as const;

async function generateBrowserFixtures(directory: string): Promise<BrowserFixture[]> {
  await mkdir(directory, { recursive: true });
  const turnsPath = join(directory, "bench-thousand-turns.jsonl");
  const thousandTurns = await generateFixture({
    scenario: BROWSER_FLUENCY_FIXTURE_SCENARIO,
    outputPath: turnsPath,
  });
  return [
    { fileName: "bench-thousand-turns.jsonl", title: "Long Session Benchmark: thousand-user-turns", manifest: thousandTurns },
  ];
}

export async function finalizeBrowserBenchmarkRoot(options: {
  root: string;
  browser: Pick<Browser, "close"> | null;
  completed: boolean;
  removeRoot?: (root: string) => Promise<void>;
}): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  let browserCloseConfirmed = options.browser === null;
  if (options.browser) {
    try {
      await options.browser.close();
      browserCloseConfirmed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (options.completed && browserCloseConfirmed) {
    try {
      await (options.removeRoot ?? ((root) =>
        rm(root, { recursive: true, force: true })))(options.root);
    } catch (error) {
      cleanupErrors.push(error);
    }
  } else {
    cleanupErrors.push(
      new Error(`Browser benchmark root retained after failure: ${options.root}`),
    );
  }
  return cleanupErrors;
}

export async function runBrowserFluencyBenchmark(options: {
  dist: string;
  iterations?: number;
  outputPath?: string;
}): Promise<BrowserFluencyResult> {
  const { root: stagingDist, identity } = await validateStagingDist(options.dist);
  const iterations = Math.max(1, Math.floor(options.iterations ?? 3));
  const root = await mkdtemp(join(tmpdir(), "pi-chat-browser-fluency-"));
  let browser: Browser | null = null;
  let completed = false;
  let primaryError: unknown;
  let result: BrowserFluencyResult | undefined;
  try {
    const fixtures = await generateBrowserFixtures(join(root, "fixtures"));
    browser = await chromium.launch({
      headless: true,
      args: ["--enable-precise-memory-info"],
    });
    const samples: BrowserFluencySample[] = [];
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      samples.push(...await measureIteration({ browser, stagingDist, root, iteration, fixtures }));
    }
    result = {
      schemaVersion: 1,
      benchmark: "pi-chat-browser-fluency",
      generatedAt: new Date().toISOString(),
      baselinePolicy: "descriptive-only",
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        chromiumVersion: browser.version(),
        headless: true,
        viewport: VIEWPORT,
      },
      isolation: {
        stagingBuild: identity,
        freshBenchmarkServerPerIteration: true,
        freshBrowserContextPerIteration: true,
        browserProcessReusedAcrossIterations: true,
        generatedTemporaryFixturesOnly: true,
        loopbackEphemeralPortNever30170: true,
      },
      fixtures: fixtures.map((fixture) => ({
        logicalName: fixture.fileName,
        ...publicFixtureMetadata(fixture.manifest),
      })),
      iterations,
      metrics: {
        actionToSettledFrameMs: "Elapsed page-clock time from user action to action-specific commit plus two animation frames.",
        paneCommitMs: "Existing Pi Chat pane-first-commit elapsed value for matching target session and source; null for load-earlier.",
        domNodeCount: "document.getElementsByTagName('*').length after the settled frame.",
        longTasks: "Renderer Long Task entries overlapping the action window; explicit unsupported values remain null.",
        heap: "Chromium renderer used JS heap from performance.memory before and after the action; not total browser or application memory.",
        anchorErrorCssPx: "Signed change in viewport-relative top of the same pre-existing first visible user message after load-earlier; absolute value is also reported.",
      },
      samples,
      summaries: aggregateBrowserFluency(samples),
      thresholds: null,
    };
    if (options.outputPath) {
      const outputPath = resolve(options.outputPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    completed = true;
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = await finalizeBrowserBenchmarkRoot({
    root,
    browser,
    completed,
  });
  const failure = combinedE2eError(
    primaryError,
    cleanupErrors,
    `Browser benchmark and cleanup failed; retained root: ${root}`,
  );
  if (failure !== undefined) throw failure;
  if (!result) throw new Error("Browser benchmark completed without a result");
  return result;
}

function parseArgs(argv: string[]): { dist: string; iterations?: number; outputPath?: string } {
  const result: { dist: string; iterations?: number; outputPath?: string } = { dist: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dist") result.dist = argv[++index] || "";
    else if (argument === "--iterations") result.iterations = Number(argv[++index]);
    else if (argument === "--output") result.outputPath = argv[++index];
    else if (argument === "--help") {
      console.log("Usage: node --import tsx benchmarks/run-browser-fluency-bench.mts --dist STAGING_DIST [--iterations N] [--output result.json]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.dist) throw new Error("--dist is required");
  if (result.iterations !== undefined && (!Number.isFinite(result.iterations) || result.iterations < 1))
    throw new Error("--iterations must be a positive number");
  return result;
}

function printSummary(result: BrowserFluencyResult): void {
  console.log("Pi Chat browser fluency benchmark (descriptive baseline; no pass/fail thresholds)");
  console.log(`Chromium ${result.environment.chromiumVersion}; ${result.iterations} iteration(s); staging revision ${result.isolation.stagingBuild.revision}`);
  for (const summary of result.summaries) {
    const anchor = summary.anchorAbsoluteErrorCssPx
      ? `; anchor error p50 ${summary.anchorAbsoluteErrorCssPx.median.toFixed(2)} px`
      : "";
    console.log(`${summary.scenario}: action-to-frame p50 ${summary.actionToSettledFrameMs.median.toFixed(2)} ms; DOM p50 ${summary.domNodeCount.median.toFixed(0)}${anchor}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runBrowserFluencyBenchmark(parseArgs(process.argv.slice(2)));
  printSummary(result);
  if (!process.argv.includes("--output")) console.log(JSON.stringify(result));
}
