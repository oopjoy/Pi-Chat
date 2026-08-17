import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  observeOwnedProcess,
  terminateOwnedProcessTreeForCleanup,
} from "../scripts/e2e-process-tree.mjs";
import {
  combinedE2eError,
  removeE2eRootAfterConfirmedTree,
} from "../scripts/e2e-root.mjs";
import { npmInvocation } from "../scripts/run-staged-verification.mjs";
import {
  streamingBenchmarkMetadata,
  type parseStreamingBenchmarkConfig,
} from "../scripts/e2e-streaming-benchmark.mjs";
import { validateStagingDist } from "./run-browser-fluency-bench.mjs";
import {
  aggregateStreamingCadence,
  assertStreamingCadenceResultPrivacy,
  streamingCadenceMatrix,
  summarizeFrameGaps,
  type StreamingCadenceCell,
  type StreamingCadenceSample,
} from "./lib/streaming-cadence.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const LIVE_PORT = 30_170;
const VIEWPORT = { width: 1_360, height: 900 };
const SERVER_START_TIMEOUT_MS = 25_000;
const SERVER_CLOSE_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 45_000;
const MAX_CAPTURED_CHILD_CHARACTERS = 128 * 1024;
const DEFAULT_UPDATE_COUNT = 60;
const DEFAULT_SOURCE_INTERVAL_MS = 20;
const START_BARRIER_LEAD_MS = 2_000;
const MAX_SOURCE_START_SKEW_MS = 100;
const MAX_SOURCE_LATENESS_MS = 250;
type ObservedOwnedProcess = ReturnType<typeof observeOwnedProcess>;
const activeOwnedProcesses = new Set<ObservedOwnedProcess>();
const pendingOwnedE2eRoots = new Set<string>();
let activeBenchmarkBrowser: Browser | null = null;
let activeBenchmarkRoot: string | null = null;
let signalCleanupStarted = false;

type StreamConfig = ReturnType<typeof parseStreamingBenchmarkConfig>;
type BuildIdentity = Awaited<ReturnType<typeof validateStagingDist>>["identity"];
type BrowserPolicyAttestation = {
  browserPolicy: "timeout-50" | "animation-frame";
  entrySha256: string;
};

type ImportedSession = { name: string; id: string };
type ImportedManifest = { sessions: ImportedSession[] };
type Auth = { token: string; client: string; page: string };

type ObservedOwnedProcess = ReturnType<typeof observeOwnedProcess>;
type RunningServer = ObservedOwnedProcess & {
  origin: string;
  serverRoot: string;
  manifestPath: string;
  stdout: () => string;
  stderr: () => string;
  serverIntervalMs: number;
};

export interface StreamingCadenceResult {
  schemaVersion: 1;
  benchmark: "pi-chat-streaming-cadence";
  generatedAt: string;
  benchmarkHarnessSha256: string;
  baselinePolicy: "descriptive-only";
  comparisonReady: boolean;
  thresholds: null;
  environment: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    chromiumVersion: string;
    headless: true;
    viewport: typeof VIEWPORT;
  };
  isolation: {
    privateOsTempStaging: true;
    freshBenchmarkServerPerSample: true;
    freshBrowserContextPerSample: true;
    generatedTemporarySessionsOnly: true;
    avoidsLiveServiceEndpoint: true;
    browserProcessReusedAcrossSamples: true;
    executionOrder: "policy-latin-square-v1";
    cleanupConfirmed: true;
    fourSessionShape: "one-visible-pane-plus-three-offscreen-cache-streams";
  };
  variants: {
    baseline: { build: BuildIdentity; browserPolicy: "timeout-50"; entrySha256: string };
    frameAligned: { build: BuildIdentity; browserPolicy: "animation-frame"; entrySha256: string };
  };
  metrics: Record<string, string>;
  iterations: number;
  samples: StreamingCadenceSample[];
  summaries: ReturnType<typeof aggregateStreamingCadence>;
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

async function runNpmBuild(stage: string, browserPolicy: "timeout-50" | "animation-frame"): Promise<void> {
  const invocation = npmInvocation(["run", "build"]);
  const environment = {
    ...process.env,
    PI_CHAT_DIST_DIR: stage,
    PI_CHAT_BENCHMARK_BROWSER_STREAMING_POLICY: browserPolicy,
  };
  delete environment.PI_CHAT_BUILD_REVISION;
  const processGroup = process.platform !== "win32";
  const child = spawn(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
    detached: true,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(invocation.command),
  });
  const observed = observeOwnedProcess(child, processGroup);
  activeOwnedProcesses.add(observed);
  try {
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    if (signal) throw new Error(`Streaming cadence staging build exited from signal ${signal}`);
    if (code !== 0) throw new Error(`Streaming cadence staging build failed with exit code ${code}`);
    await observed.close.promise;
  } finally {
    activeOwnedProcesses.delete(observed);
  }
}

function publicBuildIdentity(identity: BuildIdentity): BuildIdentity {
  if (
    identity.schemaVersion !== 1
    || typeof identity.packageVersion !== "string"
    || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(identity.packageVersion)
    || typeof identity.revision !== "string"
    || !/^(?:unknown|[a-f0-9]{7,64})$/.test(identity.revision)
    || typeof identity.fingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(identity.fingerprint)
    || typeof identity.builtAt !== "string"
    || !Number.isFinite(Date.parse(identity.builtAt))
  ) throw new Error("Streaming benchmark build identity is not safe to export");
  return {
    schemaVersion: 1,
    packageVersion: identity.packageVersion,
    revision: identity.revision,
    fingerprint: identity.fingerprint,
    builtAt: identity.builtAt,
  };
}

async function readBrowserPolicyAttestation(
  stage: string,
  expected: BrowserPolicyAttestation["browserPolicy"],
): Promise<BrowserPolicyAttestation> {
  const value = JSON.parse(
    await readFile(join(stage, "web", "streaming-benchmark-policy.json"), "utf8"),
  ) as Partial<BrowserPolicyAttestation> & { schemaVersion?: number };
  if (
    value.schemaVersion !== 1
    || value.browserPolicy !== expected
    || typeof value.entrySha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.entrySha256)
  ) throw new Error(`Streaming benchmark browser policy attestation failed for ${expected}`);
  return { browserPolicy: value.browserPolicy, entrySha256: value.entrySha256 };
}

async function buildVariants(root: string): Promise<{
  baseline: { root: string; identity: BuildIdentity; attestation: BrowserPolicyAttestation };
  frame: { root: string; identity: BuildIdentity; attestation: BrowserPolicyAttestation };
}> {
  const baselineRoot = join(root, "staging-baseline");
  const frameRoot = join(root, "staging-frame");
  await runNpmBuild(baselineRoot, "timeout-50");
  await runNpmBuild(frameRoot, "animation-frame");
  const baseline = await validateStagingDist(baselineRoot);
  const frame = await validateStagingDist(frameRoot);
  return {
    baseline: {
      ...baseline,
      attestation: await readBrowserPolicyAttestation(baselineRoot, "timeout-50"),
    },
    frame: {
      ...frame,
      attestation: await readBrowserPolicyAttestation(frameRoot, "animation-frame"),
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate benchmark port");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port === LIVE_PORT ? freePort() : port;
}

async function waitForServer(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Streaming cadence server exited before readiness");
    try {
      const response = await fetch(`${origin}/api/bootstrap/handshake`, {
        cache: "no-store",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Disposable server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  }
  throw new Error("Streaming cadence server readiness timed out");
}

function serverEnvironment(options: {
  stage: string;
  stateDirectory: string;
  configPath: string;
  serverIntervalMs: number;
}): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.PI_CHAT_DIST_DIR;
  delete environment.PI_CHAT_RUNTIME_DIST;
  delete environment.PI_CODING_AGENT_SESSION_DIR;
  delete environment.PI_CHAT_E2E_FIXTURE_DIR;
  delete environment.PI_CHAT_E2E_MANIFEST_PATH;
  environment.PI_CHAT_E2E_DIST = options.stage;
  environment.PI_CHAT_E2E_SERVER_DIST = options.stage;
  environment.PI_CHAT_E2E_STREAM_BENCHMARK_CONFIG = options.configPath;
  environment.PI_CHAT_BENCHMARK_SSE_INTERVAL_MS = String(options.serverIntervalMs);
  environment.PI_CHAT_SKIP_STALE_DIST_CLEANUP = "1";
  environment.XDG_STATE_HOME = join(options.stateDirectory, "xdg-state");
  environment.LOCALAPPDATA = join(options.stateDirectory, "local-app-data");
  return environment;
}

async function startServer(options: {
  stage: string;
  cellRoot: string;
  stateDirectory: string;
  configPath: string;
  serverIntervalMs: number;
}): Promise<RunningServer> {
  const port = await freePort();
  if (port === LIVE_PORT) throw new Error("Streaming cadence benchmark refuses live port 30170");
  const origin = `http://127.0.0.1:${port}`;
  const serverRoot = await mkdtemp(join(tmpdir(), "pi-chat-e2e-root-"));
  const fixtureDirectory = join(options.cellRoot, "fixtures");
  const manifestPath = join(options.cellRoot, "sessions.json");
  await mkdir(fixtureDirectory, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      resolve(projectRoot, "scripts", "e2e-server.mjs"),
      "--port",
      String(port),
      "--fixture-dir",
      fixtureDirectory,
      "--fixture-manifest",
      manifestPath,
      "--root",
      serverRoot,
    ],
    {
      cwd: projectRoot,
      env: serverEnvironment({
        stage: options.stage,
        stateDirectory: options.stateDirectory,
        configPath: options.configPath,
        serverIntervalMs: options.serverIntervalMs,
      }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    },
  );
  const observed = observeOwnedProcess(child, process.platform !== "win32");
  activeOwnedProcesses.add(observed);
  pendingOwnedE2eRoots.add(serverRoot);
  const stdout = captureTail(child, "stdout");
  const stderr = captureTail(child, "stderr");
  try {
    await waitForServer(origin, child);
    if (!stdout().includes(`[Pi Chat] benchmark SSE snapshot interval=${options.serverIntervalMs}ms`))
      throw new Error("Streaming cadence server policy attestation is missing");
    return {
      ...observed,
      origin,
      serverRoot,
      manifestPath,
      stdout,
      stderr,
      serverIntervalMs: options.serverIntervalMs,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let treeExitConfirmed = false;
    try {
      await terminateOwnedProcessTreeForCleanup(observed, SERVER_CLOSE_TIMEOUT_MS);
      treeExitConfirmed = true;
      activeOwnedProcesses.delete(observed);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await removeE2eRootAfterConfirmedTree(serverRoot, treeExitConfirmed);
      pendingOwnedE2eRoots.delete(serverRoot);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw combinedE2eError(
      error,
      cleanupErrors,
      `Streaming cadence server startup failed; retained root: ${serverRoot}`,
    );
  }
}

async function stopServer(server: RunningServer): Promise<void> {
  await terminateOwnedProcessTreeForCleanup(server, SERVER_CLOSE_TIMEOUT_MS);
  activeOwnedProcesses.delete(server);
}

async function importedSessions(path: string): Promise<ImportedSession[]> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as ImportedManifest;
  const sessions = Array.isArray(manifest.sessions)
    ? manifest.sessions.filter((session) => /^stream-[1-4]\.jsonl$/.test(session.name))
    : [];
  if (sessions.length !== 4) throw new Error("Streaming cadence server did not expose four benchmark Sessions");
  return sessions.sort((left, right) => left.name.localeCompare(right.name));
}

async function installBrowserProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // tsx/esbuild names nested object methods with a tiny __name helper. The
    // serialized browser script has no module prelude, so provide that no-op
    // helper before any transformed method executes.
    if (!("__name" in globalThis))
      Object.defineProperty(globalThis, "__name", { value: Function("return arguments[0]"), configurable: true });
    type BenchState = {
      eventSourceUrl: string;
      active: boolean;
      startedAt: number;
      marker: string;
      expected: Set<string>;
      visibleSessionId: string;
      settled: Set<string>;
      agentStartTimes: Map<string, number>;
      sessionEvidence: Map<string, { updates: number; messageEnd: boolean; finalMarker: boolean }>;
      parseErrors: number;
      receivedUpdateFrames: number;
      receivedUpdateBytes: number;
      visibleReceivedUpdateFrames: number;
      visibleCommitCount: number;
      firstVisibleCommitAt: number | null;
      firstPaintOpportunityAt: number | null;
      terminalPaintOpportunityAt: number | null;
      finalMarkerVisible: boolean;
      lastVisibleText: string;
      frameGaps: number[];
      lastFrameAt: number | null;
      frameHandle: number;
      mutationFrame: number;
      mutationObserver: MutationObserver | null;
      longTasksSupported: boolean;
      longTasks: Array<{ startTime: number; duration: number }>;
      longTaskObserver: PerformanceObserver | null;
      begin(input: { marker: string; expectedSessionIds: string[]; visibleSessionId: string }): void;
      snapshot(): Record<string, unknown>;
    };
    const benchWindow = window as Window & { __piStreamingCadenceBench?: BenchState };
    const state: BenchState = {
      eventSourceUrl: "",
      active: false,
      startedAt: 0,
      marker: "",
      expected: new Set(),
      visibleSessionId: "",
      settled: new Set(),
      agentStartTimes: new Map(),
      sessionEvidence: new Map(),
      parseErrors: 0,
      receivedUpdateFrames: 0,
      receivedUpdateBytes: 0,
      visibleReceivedUpdateFrames: 0,
      visibleCommitCount: 0,
      firstVisibleCommitAt: null,
      firstPaintOpportunityAt: null,
      terminalPaintOpportunityAt: null,
      finalMarkerVisible: false,
      lastVisibleText: "",
      frameGaps: [],
      lastFrameAt: null,
      frameHandle: 0,
      mutationFrame: 0,
      mutationObserver: null,
      longTasksSupported: false,
      longTasks: [],
      longTaskObserver: null,
      begin(input) {
        this.active = true;
        this.startedAt = 0;
        this.marker = input.marker;
        this.expected = new Set(input.expectedSessionIds);
        this.visibleSessionId = input.visibleSessionId;
        this.settled.clear();
        this.agentStartTimes.clear();
        this.sessionEvidence = new Map(
          input.expectedSessionIds.map((sessionId) => [
            sessionId,
            { updates: 0, messageEnd: false, finalMarker: false },
          ]),
        );
        this.parseErrors = 0;
        this.receivedUpdateFrames = 0;
        this.receivedUpdateBytes = 0;
        this.visibleReceivedUpdateFrames = 0;
        this.visibleCommitCount = 0;
        this.firstVisibleCommitAt = null;
        this.firstPaintOpportunityAt = null;
        this.terminalPaintOpportunityAt = null;
        this.finalMarkerVisible = false;
        const existingMessages = [...document.querySelectorAll<HTMLElement>(".message-assistant")];
        this.lastVisibleText = existingMessages.at(-1)?.textContent || "";
        this.frameGaps = [];
        this.lastFrameAt = null;
        this.longTasks = [];
        this.mutationObserver?.disconnect();
        const inspectVisible = () => {
          this.mutationFrame = 0;
          if (!this.active) return;
          const messages = [...document.querySelectorAll<HTMLElement>(".message-assistant")];
          const text = messages.at(-1)?.textContent || "";
          if (!text || text === this.lastVisibleText) return;
          this.lastVisibleText = text;
          this.visibleCommitCount += 1;
          const now = performance.now();
          if (this.firstVisibleCommitAt === null) {
            this.firstVisibleCommitAt = now;
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (this.firstPaintOpportunityAt === null)
                this.firstPaintOpportunityAt = performance.now();
            }));
          }
          if (text.includes(this.marker)) this.finalMarkerVisible = true;
        };
        this.mutationObserver = new MutationObserver(() => {
          if (!this.mutationFrame)
            this.mutationFrame = requestAnimationFrame(inspectVisible);
        });
        this.mutationObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
      },
      snapshot() {
        const records = this.longTaskObserver?.takeRecords() || [];
        for (const entry of records) this.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        const selected = this.longTasks.filter((entry) =>
          this.startedAt > 0 && entry.startTime + entry.duration >= this.startedAt,
        );
        const starts = [...this.agentStartTimes.values()];
        const visibleStartedAt = this.agentStartTimes.get(this.visibleSessionId) ?? this.startedAt;
        const output = {
          eventSourceUrl: this.eventSourceUrl,
          firstVisibleDomObservationMs: this.firstVisibleCommitAt === null ? -1 : this.firstVisibleCommitAt - visibleStartedAt,
          firstVisibleDomObservationPaintOpportunityMs: this.firstPaintOpportunityAt === null ? -1 : this.firstPaintOpportunityAt - visibleStartedAt,
          messageEndPaintOpportunityMs: this.terminalPaintOpportunityAt === null ? -1 : this.terminalPaintOpportunityAt - visibleStartedAt,
          visibleDomObservationCount: this.visibleCommitCount,
          receivedUpdateFrames: this.receivedUpdateFrames,
          receivedUpdateBytes: this.receivedUpdateBytes,
          visibleReceivedUpdateFrames: this.visibleReceivedUpdateFrames,
          settledSessions: this.settled.size,
          allExpectedSessionsSettled: this.settled.size === this.expected.size,
          startSkewMs: starts.length < 2 ? 0 : Math.max(...starts) - Math.min(...starts),
          finalMarkerVisible: this.finalMarkerVisible,
          allSessionsReceivedUpdates: [...this.sessionEvidence.values()].every((evidence) => evidence.updates > 0),
          allSessionsReceivedMessageEnd: [...this.sessionEvidence.values()].every((evidence) => evidence.messageEnd),
          allSessionsReceivedFinalMarker: [...this.sessionEvidence.values()].every((evidence) => evidence.finalMarker),
          parseErrors: this.parseErrors,
          frameGaps: [...this.frameGaps],
          longTasks: {
            supported: this.longTasksSupported,
            count: this.longTasksSupported ? selected.length : null,
            totalDurationMs: this.longTasksSupported ? selected.reduce((total, entry) => total + entry.duration, 0) : null,
            maxDurationMs: this.longTasksSupported ? Math.max(0, ...selected.map((entry) => entry.duration)) : null,
          },
        };
        this.active = false;
        if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
        if (this.mutationFrame) cancelAnimationFrame(this.mutationFrame);
        this.frameHandle = 0;
        this.mutationFrame = 0;
        this.mutationObserver?.disconnect();
        return output;
      },
    };
    try {
      state.longTasksSupported = (PerformanceObserver.supportedEntryTypes || []).includes("longtask");
      if (state.longTasksSupported) {
        state.longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        });
        state.longTaskObserver.observe({ type: "longtask", buffered: false });
      }
    } catch {
      state.longTasksSupported = false;
    }
    benchWindow.__piStreamingCadenceBench = state;
    const nativeAddEventListener = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function(type, listener, options) {
      const observed = this as EventSource & { __piStreamingCadenceObserved?: boolean };
      if (type === "pi" && !observed.__piStreamingCadenceObserved) {
        observed.__piStreamingCadenceObserved = true;
        nativeAddEventListener.call(this, "pi", (rawEvent) => {
          if (!state.active) return;
          try {
            const messageEvent = rawEvent as MessageEvent<string>;
            const event = JSON.parse(messageEvent.data) as Record<string, unknown>;
            const sessionId = typeof event.piChatSessionId === "string" ? event.piChatSessionId : "";
            if (!state.expected.has(sessionId)) return;
            const eventType = String(event.type || "");
            const now = performance.now();
            if (eventType === "agent_start") {
              state.agentStartTimes.set(sessionId, now);
              if (sessionId === state.visibleSessionId && state.frameHandle === 0) {
                state.startedAt = now;
                state.longTasks = [];
                const frame = (at: number) => {
                  if (!state.active) return;
                  if (state.lastFrameAt !== null) state.frameGaps.push(at - state.lastFrameAt);
                  state.lastFrameAt = at;
                  state.frameHandle = requestAnimationFrame(frame);
                };
                state.frameHandle = requestAnimationFrame(frame);
              }
            }
            const evidence = state.sessionEvidence.get(sessionId);
            if (eventType === "message_update") {
              if (evidence) evidence.updates += 1;
              state.receivedUpdateFrames += 1;
              state.receivedUpdateBytes += new TextEncoder().encode(messageEvent.data).byteLength;
              if (sessionId === state.visibleSessionId) state.visibleReceivedUpdateFrames += 1;
            }
            if (eventType === "message_end") {
              if (evidence) {
                evidence.messageEnd = true;
                evidence.finalMarker = JSON.stringify(event.message || "").includes(state.marker);
              }
              if (sessionId === state.visibleSessionId) {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  if (state.terminalPaintOpportunityAt === null)
                    state.terminalPaintOpportunityAt = performance.now();
                }));
              }
            }
            if (eventType === "agent_settled") state.settled.add(sessionId);
          } catch {
            state.parseErrors += 1;
          }
        });
      }
      return nativeAddEventListener.call(this, type, listener, options);
    };
  });
}

function authFromEventSourceUrl(value: string): Auth {
  const url = new URL(value, "http://127.0.0.1");
  const token = url.searchParams.get("token") || "";
  const client = url.searchParams.get("client") || "";
  const page = url.searchParams.get("page") || "";
  if (!token || !client || !page) throw new Error("Benchmark browser EventSource authority is incomplete");
  return { token, client, page };
}

async function apiRequest<T>(
  origin: string,
  auth: Auth,
  pathname: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, {
    method: options.method || "GET",
    headers: {
      origin,
      "x-pi-chat-token": auth.token,
      "x-pi-chat-client": auth.client,
      "x-pi-chat-page": auth.page,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
  });
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error || `Benchmark API failed with ${response.status}`);
  return value;
}

async function exposeSession(page: Page, title: string): Promise<void> {
  const search = page.getByRole("searchbox", { name: "搜索对话" });
  await search.fill(title);
  const row = page.locator(".session-item", { hasText: title });
  try {
    await row.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    const directory = page.locator(".session-directory", { hasText: "/pi-chat-benchmark/fixture-workspace" });
    const toggle = directory.locator(".session-directory-toggle");
    await toggle.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await row.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  }
}

function aggregateServerSummaries(
  snapshot: unknown,
  expectedSummaries?: number,
  expectedUpdatesPerSummary?: number,
): StreamingCadenceSample["server"] {
  const totals: StreamingCadenceSample["server"] = {
    summaryCount: 0,
    snapshotsWritten: 0,
    snapshotsBackpressured: 0,
    snapshotsScheduled: 0,
    snapshotsReplaced: 0,
    snapshotsQueued: 0,
    snapshotsQueueReplaced: 0,
    snapshotsOversized: 0,
    snapshotsNoClients: 0,
    snapshotsWriteErrors: 0,
  };
  const entries = snapshot && typeof snapshot === "object" && Array.isArray((snapshot as { entries?: unknown[] }).entries)
    ? (snapshot as { entries: Array<Record<string, unknown>> }).entries
    : [];
  const keys = Object.keys(totals).filter((key) => key !== "summaryCount") as Array<keyof typeof totals>;
  for (const entry of entries) {
    if (entry.category !== "sse-transport" || entry.name !== "snapshot-summary") continue;
    const details = entry.details && typeof entry.details === "object"
      ? entry.details as Record<string, unknown>
      : {};
    totals.summaryCount += 1;
    for (const key of keys) {
      const value = details[key];
      if (typeof value === "number" && Number.isFinite(value)) totals[key] += value;
    }
    if (
      expectedUpdatesPerSummary !== undefined
      && Number(details.snapshotsWritten || 0) + Number(details.snapshotsReplaced || 0)
        !== expectedUpdatesPerSummary
    ) throw new Error("Streaming cadence server summary does not account for every source update");
  }
  if (expectedSummaries !== undefined && totals.summaryCount !== expectedSummaries)
    throw new Error("Streaming cadence server summary count is incorrect");
  return totals;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

export async function readStreamingSourceTiming(
  cellRoot: string,
  runtimeNames: string[],
  config: StreamConfig,
): Promise<Pick<StreamingCadenceSample["source"],
  "emittedUpdates" | "actualDurationMs" | "actualMeanIntervalMs"
  | "actualP95IntervalMs" | "actualMaxIntervalMs" | "actualMaxLatenessMs"
  | "startSkewMs"
>> {
  if (config.startAt === null) throw new Error("Source timing requires an active start barrier");
  const reports = await Promise.all(runtimeNames.map(async (name) => {
    const runtimeName = name.replace(/\.jsonl$/, "");
    const value = JSON.parse(
      await readFile(join(cellRoot, `source-${runtimeName}.json`), "utf8"),
    ) as { sourceTimes?: unknown[] };
    const times = Array.isArray(value.sourceTimes)
      ? value.sourceTimes.filter((item): item is number => Number.isSafeInteger(item))
      : [];
    if (times.length !== config.updateCount)
      throw new Error("Streaming benchmark source report has the wrong update count");
    const intervals = times.slice(1).map((time, index) => time - times[index]);
    const duration = times.at(-1)! - times[0];
    const expectedDuration = (config.updateCount - 1) * config.sourceIntervalMs;
    if (duration < expectedDuration * 0.75 || duration > expectedDuration * 1.5)
      throw new Error(`Streaming benchmark source duration drifted outside tolerance: ${duration}ms`);
    const meanInterval = intervals.reduce((total, value) => total + value, 0) / Math.max(1, intervals.length);
    const p95Interval = percentile(intervals, 0.95);
    const maxInterval = percentile(intervals, 1);
    const maxLateness = Math.max(0, ...times.map((time, index) =>
      time - (config.startAt! + index * config.sourceIntervalMs)
    ));
    if (maxLateness > MAX_SOURCE_LATENESS_MS)
      throw new Error("Streaming benchmark source deadline lateness exceeded operational tolerance");
    if (
      meanInterval < config.sourceIntervalMs * 0.75
      || meanInterval > config.sourceIntervalMs * 1.25
      || p95Interval > config.sourceIntervalMs * 2
      || maxInterval > config.sourceIntervalMs * 2.5
    ) throw new Error("Streaming benchmark source interval quality exceeded operational tolerance");
    return {
      times,
      duration,
      meanInterval,
      p95Interval,
      maxInterval,
      maxLateness,
    };
  }));
  const starts = reports.map((report) => report.times[0]);
  return {
    emittedUpdates: config.updateCount,
    actualDurationMs: round(Math.max(...reports.map((report) => report.duration))),
    actualMeanIntervalMs: round(Math.max(...reports.map((report) => report.meanInterval))),
    actualP95IntervalMs: round(Math.max(...reports.map((report) => report.p95Interval))),
    actualMaxIntervalMs: round(Math.max(...reports.map((report) => report.maxInterval))),
    actualMaxLatenessMs: round(Math.max(...reports.map((report) => report.maxLateness))),
    startSkewMs: round(starts.length < 2 ? 0 : Math.max(...starts) - Math.min(...starts)),
  };
}

async function measureSample(options: {
  browser: Browser;
  root: string;
  iteration: number;
  cell: StreamingCadenceCell;
  stage: string;
  browserAttestation: BrowserPolicyAttestation;
  executionOrdinal: number;
}): Promise<StreamingCadenceSample> {
  const cellName = `${options.cell.key}-${options.cell.concurrency}-${options.cell.contentKind}-${options.iteration}`;
  const cellRoot = join(options.root, "samples", cellName);
  const stateDirectory = join(cellRoot, "state");
  const configPath = join(cellRoot, "stream-config.json");
  await mkdir(stateDirectory, { recursive: true });
  const finalMarker = `PI_CHAT_STREAM_FINAL_${options.cell.concurrency}_${options.iteration}_${options.cell.contentKind === "plain" ? "PLAIN" : "MARKDOWN"}`;
  const baseConfig: StreamConfig = {
    schemaVersion: 1,
    contentKind: options.cell.contentKind,
    updateCount: DEFAULT_UPDATE_COUNT,
    sourceIntervalMs: DEFAULT_SOURCE_INTERVAL_MS,
    startAt: null,
    finalMarker,
  };
  await writeFile(configPath, `${JSON.stringify(baseConfig)}\n`, "utf8");
  const server = await startServer({
    stage: options.stage,
    cellRoot,
    stateDirectory,
    configPath,
    serverIntervalMs: options.cell.serverIntervalMs,
  });
  let context: BrowserContext | null = null;
  let primaryError: unknown;
  try {
    const sessions = await importedSessions(server.manifestPath);
    const selected = sessions.slice(0, options.cell.concurrency);
    const visible = selected[0];
    context = await options.browser.newContext({ viewport: VIEWPORT });
    await installBrowserProbe(context);
    const page = await context.newPage();
    const eventSourceRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname === "/api/events"
    );
    await page.goto(server.origin, { waitUntil: "domcontentloaded" });
    await page.getByText("First answer", { exact: true }).waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    const eventSourceUrl = (await eventSourceRequest).url();
    const auth = authFromEventSourceUrl(eventSourceUrl);
    const browserRuntimeAttestation = await page.evaluate(async () => {
      const response = await fetch("/streaming-benchmark-policy.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Browser policy attestation resource is unavailable");
      return response.json();
    }) as BrowserPolicyAttestation & { schemaVersion?: number };
    if (
      browserRuntimeAttestation.schemaVersion !== 1
      || browserRuntimeAttestation.browserPolicy !== options.cell.browserPolicy
      || browserRuntimeAttestation.browserPolicy !== options.browserAttestation.browserPolicy
      || browserRuntimeAttestation.entrySha256 !== options.browserAttestation.entrySha256
    ) throw new Error("Browser runtime policy attestation does not match the benchmark cell");
    const fontsReady = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.status === "loaded";
    });
    if (!fontsReady) throw new Error("Browser fonts were not ready before the streaming barrier");

    await exposeSession(page, "Streaming Benchmark 1");
    await page.locator(".session-item", { hasText: "Streaming Benchmark 1" }).click();
    await page.getByText("Ready for deterministic streaming", { exact: true }).waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });

    await Promise.all(selected.map((session) =>
      apiRequest(server.origin, auth, `/api/sessions/${session.id}/warm`, { method: "POST" })
    ));
    await Promise.all(selected.map((session) =>
      apiRequest(server.origin, auth, `/api/sessions/${session.id}/control`, { method: "POST" })
    ));

    const activeConfig: StreamConfig = {
      ...baseConfig,
      startAt: Date.now() + START_BARRIER_LEAD_MS,
    };
    await writeFile(configPath, `${JSON.stringify(activeConfig)}\n`, "utf8");
    await page.evaluate(({ marker, expectedSessionIds, visibleSessionId }) => {
      const state = (window as Window & {
        __piStreamingCadenceBench?: {
          begin(input: { marker: string; expectedSessionIds: string[]; visibleSessionId: string }): void;
        };
      }).__piStreamingCadenceBench;
      if (!state) throw new Error("Streaming cadence browser probe is unavailable");
      state.begin({ marker, expectedSessionIds, visibleSessionId });
    }, {
      marker: finalMarker,
      expectedSessionIds: selected.map((session) => session.id),
      visibleSessionId: visible.id,
    });

    const promptResponses = await Promise.all(selected.map((session) =>
      apiRequest<{ accepted?: boolean; queued?: boolean }>(server.origin, auth, "/api/chat/prompt", {
        method: "POST",
        body: { message: "deterministic benchmark", sessionId: session.id, delivery: "queue", images: [] },
      })
    ));
    if (promptResponses.some((response) => response.accepted !== true))
      throw new Error("One or more benchmark prompts were not accepted");

    await page.waitForFunction(({ expected }) => {
      const state = (window as Window & {
        __piStreamingCadenceBench?: {
          settled: Set<string>;
          finalMarkerVisible: boolean;
          firstPaintOpportunityAt: number | null;
          terminalPaintOpportunityAt: number | null;
        };
      }).__piStreamingCadenceBench;
      return Boolean(
        state
        && state.settled.size === expected
        && state.finalMarkerVisible
        && state.firstPaintOpportunityAt !== null
        && state.terminalPaintOpportunityAt !== null
      );
    }, { expected: options.cell.concurrency }, { timeout: ACTION_TIMEOUT_MS });

    const renderedStructure = await page.evaluate(() => {
      const messages = [...document.querySelectorAll<HTMLElement>(".message-assistant")];
      const message = messages.at(-1);
      return {
        headings: message?.querySelectorAll("h1, h2, h3, h4, h5, h6").length || 0,
        tables: message?.querySelectorAll("table").length || 0,
        codeBlocks: message?.querySelectorAll("pre code").length || 0,
        katexNodes: message?.querySelectorAll(".katex").length || 0,
        katexErrors: message?.querySelectorAll(".katex-error").length || 0,
      };
    });
    if (
      options.cell.contentKind === "markdown-katex"
      && (
        renderedStructure.headings < 1
        || renderedStructure.tables < 1
        || renderedStructure.codeBlocks < 1
        || renderedStructure.katexNodes < 2
        || renderedStructure.katexErrors !== 0
      )
    ) throw new Error("Markdown/KaTeX structural rendering proof is incomplete");

    const browserRaw = await page.evaluate(() => {
      const state = (window as Window & { __piStreamingCadenceBench?: { snapshot(): Record<string, unknown> } }).__piStreamingCadenceBench;
      if (!state) throw new Error("Streaming cadence browser probe disappeared");
      return state.snapshot();
    }) as Record<string, unknown>;
    let offscreenTerminalCachesVerified = 0;
    for (let index = 1; index < selected.length; index += 1) {
      const title = `Streaming Benchmark ${index + 1}`;
      await exposeSession(page, title);
      await page.locator(".session-item", { hasText: title }).click();
      await page.locator(".message-assistant", { hasText: finalMarker }).last()
        .waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
      offscreenTerminalCachesVerified += 1;
    }
    const diagnosticSnapshot = await apiRequest<unknown>(server.origin, auth, "/api/diagnostics/snapshot");
    const metadata = streamingBenchmarkMetadata(activeConfig);
    const measuredSource = await readStreamingSourceTiming(
      cellRoot,
      selected.map((session) => session.name),
      activeConfig,
    );
    if (
      measuredSource.startSkewMs > MAX_SOURCE_START_SKEW_MS
      || measuredSource.actualMaxLatenessMs > MAX_SOURCE_LATENESS_MS
    ) throw new Error("Streaming benchmark source scheduling exceeded operational tolerance");
    const firstVisibleDomObservationMs = Number(browserRaw.firstVisibleDomObservationMs);
    const firstVisibleDomObservationPaintOpportunityMs = Number(browserRaw.firstVisibleDomObservationPaintOpportunityMs);
    const messageEndPaintOpportunityMs = Number(browserRaw.messageEndPaintOpportunityMs);
    if (
      firstVisibleDomObservationMs < 0
      || firstVisibleDomObservationPaintOpportunityMs < 0
      || messageEndPaintOpportunityMs < 0
      || browserRaw.finalMarkerVisible !== true
      || browserRaw.allExpectedSessionsSettled !== true
      || browserRaw.allSessionsReceivedUpdates !== true
      || browserRaw.allSessionsReceivedMessageEnd !== true
      || browserRaw.allSessionsReceivedFinalMarker !== true
      || Number(browserRaw.parseErrors) !== 0
      || offscreenTerminalCachesVerified !== Math.max(0, options.cell.concurrency - 1)
    ) throw new Error("Streaming cadence browser correctness proof is incomplete");
    const frameGaps = Array.isArray(browserRaw.frameGaps)
      ? browserRaw.frameGaps.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];
    const longTasks = browserRaw.longTasks as StreamingCadenceSample["browser"]["longTasks"];
    const sample: StreamingCadenceSample = {
      iteration: options.iteration,
      executionOrdinal: options.executionOrdinal,
      cell: options.cell,
      attestation: {
        browserPolicy: browserRuntimeAttestation.browserPolicy,
        webEntrySha256: browserRuntimeAttestation.entrySha256,
        serverIntervalMs: server.serverIntervalMs,
      },
      source: { ...metadata, ...measuredSource },
      browser: {
        firstVisibleDomObservationMs: round(firstVisibleDomObservationMs),
        firstVisibleDomObservationPaintOpportunityMs: round(firstVisibleDomObservationPaintOpportunityMs),
        messageEndPaintOpportunityMs: round(messageEndPaintOpportunityMs),
        visibleDomObservationCount: Number(browserRaw.visibleDomObservationCount),
        receivedUpdateFrames: Number(browserRaw.receivedUpdateFrames),
        receivedUpdateBytes: Number(browserRaw.receivedUpdateBytes),
        visibleReceivedUpdateFrames: Number(browserRaw.visibleReceivedUpdateFrames),
        allExpectedSessionsSettled: true,
        settledSessions: Number(browserRaw.settledSessions),
        startSkewMs: round(Number(browserRaw.startSkewMs)),
        finalMarkerVisible: true,
        allSessionsReceivedUpdates: true,
        allSessionsReceivedMessageEnd: true,
        allSessionsReceivedFinalMarker: true,
        parseErrors: 0,
        offscreenTerminalCachesVerified,
        fontsReady,
        renderedStructure: options.cell.contentKind === "markdown-katex" ? renderedStructure : null,
        frameGaps: summarizeFrameGaps(frameGaps),
        longTasks: {
          supported: longTasks?.supported === true,
          count: typeof longTasks?.count === "number" ? longTasks.count : null,
          totalDurationMs: typeof longTasks?.totalDurationMs === "number" ? round(longTasks.totalDurationMs) : null,
          maxDurationMs: typeof longTasks?.maxDurationMs === "number" ? round(longTasks.maxDurationMs) : null,
        },
      },
      server: aggregateServerSummaries(
        diagnosticSnapshot,
        options.cell.concurrency,
        activeConfig.updateCount,
      ),
    };
    if (sample.browser.settledSessions !== options.cell.concurrency)
      throw new Error("Streaming cadence settlement count is incorrect");
    if (
      sample.server.snapshotsBackpressured !== 0
      || sample.server.snapshotsQueued !== 0
      || sample.server.snapshotsQueueReplaced !== 0
      || sample.server.snapshotsOversized !== 0
      || sample.server.snapshotsNoClients !== 0
      || sample.server.snapshotsWriteErrors !== 0
    ) throw new Error("Streaming cadence transport encountered an invalid operational outcome");
    return sample;
  } catch (error) {
    primaryError = new Error([
      error instanceof Error ? error.stack || error.message : String(error),
      server.stdout() ? `server stdout:\n${server.stdout()}` : "",
      server.stderr() ? `server stderr:\n${server.stderr()}` : "",
    ].filter(Boolean).join("\n\n"));
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await context?.close(); } catch (error) { cleanupErrors.push(error); }
    let treeExitConfirmed = false;
    try {
      await stopServer(server);
      treeExitConfirmed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await removeE2eRootAfterConfirmedTree(server.serverRoot, treeExitConfirmed);
      pendingOwnedE2eRoots.delete(server.serverRoot);
    } catch (error) {
      cleanupErrors.push(error);
    }
    const failure = combinedE2eError(
      primaryError,
      cleanupErrors,
      `Streaming cadence sample failed; retained root: ${cellRoot}`,
    );
    if (failure !== undefined) throw failure;
  }
  throw new Error("Streaming cadence sample ended without a result");
}

async function cleanupAfterSignal(signal: NodeJS.Signals): Promise<never> {
  if (signalCleanupStarted) await new Promise<never>(() => {});
  signalCleanupStarted = true;
  const errors: unknown[] = [];
  for (const observed of [...activeOwnedProcesses]) {
    try {
      await terminateOwnedProcessTreeForCleanup(observed, SERVER_CLOSE_TIMEOUT_MS);
      activeOwnedProcesses.delete(observed);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) {
    for (const ownedRoot of [...pendingOwnedE2eRoots]) {
      try {
        await removeE2eRootAfterConfirmedTree(ownedRoot, true);
        pendingOwnedE2eRoots.delete(ownedRoot);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (activeBenchmarkBrowser) {
    try { await activeBenchmarkBrowser.close(); }
    catch (error) { errors.push(error); }
    activeBenchmarkBrowser = null;
  }
  if (activeBenchmarkRoot && errors.length === 0) {
    try {
      await rm(activeBenchmarkRoot, { recursive: true, force: true });
      activeBenchmarkRoot = null;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0 && activeBenchmarkRoot)
    console.error(`Streaming cadence signal cleanup retained root: ${activeBenchmarkRoot}`);
  else
    console.error(`Streaming cadence benchmark stopped by ${signal}; owned cleanup confirmed`);
  process.exit(errors.length > 0 ? 1 : signal === "SIGINT" ? 130 : 143);
}

function installSignalCleanup(): () => void {
  const onInterrupt = () => { void cleanupAfterSignal("SIGINT"); };
  const onTerminate = () => { void cleanupAfterSignal("SIGTERM"); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  return () => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  };
}

function pathKey(value: string): string {
  let resolved = resolve(value);
  if (process.platform !== "win32") return resolved;
  const extendedPrefix = "\\\\" + "?\\";
  const extendedUncPrefix = extendedPrefix + "UNC\\";
  const ntObjectPrefix = "\\" + "??\\";
  if (resolved.toLowerCase().startsWith(extendedUncPrefix.toLowerCase()))
    resolved = "\\\\" + resolved.slice(extendedUncPrefix.length);
  else if (resolved.startsWith(extendedPrefix))
    resolved = resolved.slice(extendedPrefix.length);
  else if (resolved.startsWith(ntObjectPrefix))
    resolved = resolved.slice(ntObjectPrefix.length);
  return resolved.toLowerCase();
}

function isWithinOrSame(base: string, target: string): boolean {
  if (pathKey(base) === pathKey(target)) return true;
  const fromBase = relative(base, target);
  return fromBase !== "" && fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase);
}

async function canonicalExistingAncestor(value: string): Promise<string> {
  let current = resolve(value);
  while (true) {
    try { return await realpath(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * Resolve every symlink/junction ancestor in a target path without requiring
 * its destination to exist. Unit staging deliberately leaves the normal live
 * `dist` absent, so follow chained dangling links before a later write can
 * recreate and reach that protected destination.
 */
async function linkedAncestorDestinations(value: string): Promise<string[]> {
  let current = resolve(value);
  const destinations: string[] = [];
  const seen = new Set<string>();
  for (let hops = 0; hops < 40; hops += 1) {
    const suffix: string[] = [];
    let candidate = current;
    while (true) {
      try {
        const destination = resolve(dirname(candidate), await readlink(candidate), ...suffix);
        const key = pathKey(destination);
        if (seen.has(key)) throw new Error("Streaming cadence output link path contains a cycle");
        seen.add(key);
        destinations.push(destination);
        current = destination;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EINVAL" || code === "UNKNOWN") return destinations;
        if (code !== "ENOENT") throw error;
        const parent = dirname(candidate);
        if (parent === candidate) return destinations;
        suffix.unshift(candidate.slice(parent.length).replace(/^[\\/]+/, ""));
        candidate = parent;
      }
    }
  }
  throw new Error("Streaming cadence output link path exceeds the maximum link depth");
}

export async function validateStreamingCadenceOutputPath(value: string): Promise<string> {
  const target = resolve(value);
  // A test/build stage may replace the live dist with PI_CHAT_DIST_DIR. Keep
  // protecting the source-tree dist too: the benchmark is never allowed to
  // write production artifacts, even while validation emits elsewhere.
  const liveDists = [...new Set([
    resolve(projectRoot, "dist"),
    resolve(process.cwd(), "dist"),
    process.env.PI_CHAT_DIST_DIR,
  ].filter((path): path is string => Boolean(path)).map(pathKey))];
  if (liveDists.some((liveDist) => isWithinOrSame(liveDist, target)))
    throw new Error("Streaming cadence output cannot target the live dist tree");
  const linkedTargets = await linkedAncestorDestinations(target);
  if (linkedTargets.some((linkedTarget) => liveDists.some((liveDist) => isWithinOrSame(liveDist, linkedTarget))))
    throw new Error("Streaming cadence output cannot reach live dist through a filesystem link");
  const canonicalTargetAncestor = await canonicalExistingAncestor(target);
  for (const liveDist of liveDists) {
    const canonicalLiveDist = await canonicalExistingAncestor(liveDist);
    if (isWithinOrSame(canonicalLiveDist, canonicalTargetAncestor))
      throw new Error("Streaming cadence output cannot reach live dist through a filesystem link");
    // Windows can preserve a junction spelling through realpath(), so compare
    // filesystem identity as the final fail-closed check.
    const [liveIdentity, targetIdentity] = await Promise.all([
      stat(canonicalLiveDist),
      stat(canonicalTargetAncestor),
    ]);
    if (liveIdentity.dev === targetIdentity.dev && liveIdentity.ino === targetIdentity.ino)
      throw new Error("Streaming cadence output cannot reach live dist through a filesystem link");
  }
  return target;
}

export function streamingCadenceComparisonReady(iterations: number): boolean {
  return iterations >= 3 && iterations % 3 === 0;
}

export async function benchmarkHarnessSha256(): Promise<string> {
  const files = [
    ["run-streaming-cadence-bench.mts", import.meta.filename],
    ["lib/streaming-cadence.mts", resolve(import.meta.dirname, "lib", "streaming-cadence.mts")],
  ] as const;
  const hash = createHash("sha256");
  for (const [name, path] of files) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function streamingCadenceOrder(iteration: number): StreamingCadenceCell[] {
  const matrix = streamingCadenceMatrix();
  const groups = (["A", "B", "C"] as const).map((key) =>
    matrix.filter((cell) => cell.key === key)
  );
  const policyRotation = (iteration - 1) % groups.length;
  const orderedGroups = groups.slice(policyRotation).concat(groups.slice(0, policyRotation));
  return orderedGroups.flatMap((group) => {
    const innerRotation = (iteration - 1) % group.length;
    return group.slice(innerRotation).concat(group.slice(0, innerRotation));
  });
}

export async function runStreamingCadenceBenchmark(options: {
  iterations?: number;
  outputPath?: string;
}): Promise<StreamingCadenceResult> {
  const iterations = Math.max(1, Math.floor(options.iterations ?? 3));
  const outputPath = options.outputPath
    ? await validateStreamingCadenceOutputPath(options.outputPath)
    : undefined;
  if (outputPath) await rm(outputPath, { force: true });
  const root = await mkdtemp(join(tmpdir(), "pi-chat-streaming-cadence-"));
  activeBenchmarkRoot = root;
  let browser: Browser | null = null;
  let completed = false;
  let primaryError: unknown;
  let result: StreamingCadenceResult | undefined;
  try {
    const variants = await buildVariants(root);
    browser = await chromium.launch({ headless: true });
    activeBenchmarkBrowser = browser;
    const samples: StreamingCadenceSample[] = [];
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      for (const cell of streamingCadenceOrder(iteration)) {
        const stage = cell.stage === "baseline" ? variants.baseline.root : variants.frame.root;
        const variant = cell.stage === "baseline" ? variants.baseline : variants.frame;
        samples.push(await measureSample({
          browser,
          root,
          iteration,
          cell,
          stage,
          browserAttestation: variant.attestation,
          executionOrdinal: samples.length + 1,
        }));
      }
    }
    result = {
      schemaVersion: 1,
      benchmark: "pi-chat-streaming-cadence",
      generatedAt: new Date().toISOString(),
      benchmarkHarnessSha256: await benchmarkHarnessSha256(),
      baselinePolicy: "descriptive-only",
      comparisonReady: streamingCadenceComparisonReady(iterations),
      thresholds: null,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        chromiumVersion: browser.version(),
        headless: true,
        viewport: VIEWPORT,
      },
      isolation: {
        privateOsTempStaging: true,
        freshBenchmarkServerPerSample: true,
        freshBrowserContextPerSample: true,
        generatedTemporarySessionsOnly: true,
        avoidsLiveServiceEndpoint: true,
        browserProcessReusedAcrossSamples: true,
        executionOrder: "policy-latin-square-v1",
        cleanupConfirmed: true,
        fourSessionShape: "one-visible-pane-plus-three-offscreen-cache-streams",
      },
      variants: {
        baseline: {
          build: publicBuildIdentity(variants.baseline.identity),
          browserPolicy: variants.baseline.attestation.browserPolicy,
          entrySha256: variants.baseline.attestation.entrySha256,
        },
        frameAligned: {
          build: publicBuildIdentity(variants.frame.identity),
          browserPolicy: variants.frame.attestation.browserPolicy,
          entrySha256: variants.frame.attestation.entrySha256,
        },
      },
      metrics: {
        firstVisibleDomObservationMs: "Browser time from the visible Session agent_start frame to the first frame-coalesced DOM text observation of changed assistant output.",
        firstVisibleDomObservationPaintOpportunityMs: "Browser time from visible agent_start to the guarded double-requestAnimationFrame opportunity after that DOM observation.",
        messageEndPaintOpportunityMs: "Browser time from visible agent_start to the double-requestAnimationFrame opportunity after the visible message_end transport frame.",
        browserStartSkewMs: "Difference between earliest and latest expected agent_start receive times in the browser.",
        sourceTiming: "Source-process first/last emission duration, interval distribution, deadline lateness, and cross-process start skew.",
        frameGaps: "requestAnimationFrame callback gaps while the sample is active; this is renderer scheduling evidence, not physical-display telemetry.",
        longTasks: "Renderer Long Task entries overlapping the sample window; unsupported values remain null.",
      },
      iterations,
      samples,
      summaries: aggregateStreamingCadence(samples),
    };
    assertStreamingCadenceResultPrivacy(result);
    completed = true;
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  let browserCloseConfirmed = browser === null;
  if (browser) {
    try {
      await browser.close();
      browserCloseConfirmed = true;
      activeBenchmarkBrowser = null;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (completed && browserCloseConfirmed) {
    try {
      await rm(root, { recursive: true, force: true });
      activeBenchmarkRoot = null;
    }
    catch (error) { cleanupErrors.push(error); }
  } else {
    cleanupErrors.push(new Error(`Streaming cadence root retained after failure: ${root}`));
  }
  const failure = combinedE2eError(
    primaryError,
    cleanupErrors,
    `Streaming cadence benchmark failed; retained root: ${root}`,
  );
  if (failure !== undefined) throw failure;
  if (!result) throw new Error("Streaming cadence benchmark completed without a result");
  if (outputPath) {
    await validateStreamingCadenceOutputPath(outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    const temporaryOutput = `${outputPath}.incomplete-${process.pid}`;
    try {
      await writeFile(temporaryOutput, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      await rename(temporaryOutput, outputPath);
    } finally {
      await rm(temporaryOutput, { force: true });
    }
  }
  return result;
}

function parseArgs(argv: string[]): { iterations?: number; outputPath?: string } {
  const result: { iterations?: number; outputPath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--iterations") result.iterations = Number(argv[++index]);
    else if (argument === "--output") result.outputPath = argv[++index] || "";
    else if (argument === "--help") {
      console.log("Usage: node --import tsx benchmarks/run-streaming-cadence-bench.mts [--iterations N] [--output result.json]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.iterations !== undefined && (!Number.isFinite(result.iterations) || result.iterations < 1))
    throw new Error("--iterations must be a positive number");
  return result;
}

function printSummary(result: StreamingCadenceResult): void {
  console.log("Pi Chat streaming cadence benchmark (descriptive only; no thresholds)");
  console.log(`Chromium ${result.environment.chromiumVersion}; ${result.iterations} iteration(s); 12 cells`);
  for (const summary of result.summaries) {
    const cell = summary.cell;
    console.log(
      `${cell.key}/${cell.concurrency}/${cell.contentKind}: first DOM observation p50 ${summary.firstVisibleDomObservationMs.median.toFixed(2)} ms; `
      + `observation paint opportunity p50 ${summary.firstVisibleDomObservationPaintOpportunityMs.median.toFixed(2)} ms; message_end paint opportunity p50 ${summary.messageEndPaintOpportunityMs.median.toFixed(2)} ms; `
      + `max frame gap p50 ${summary.maxFrameGapMs.median.toFixed(2)} ms`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const disposeSignalCleanup = installSignalCleanup();
  try {
    const result = await runStreamingCadenceBenchmark(parseArgs(process.argv.slice(2)));
    printSummary(result);
    if (!process.argv.includes("--output")) console.log(JSON.stringify(result));
  } finally {
    disposeSignalCleanup();
  }
}
