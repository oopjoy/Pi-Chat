#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiChatApp } from "./app.js";
import { PrimaryRuntimeReadinessController } from "./primary-runtime-readiness.js";
import { ModelManager } from "./model-manager.js";
import { ResourceManager } from "./resource-manager.js";
import { PiRpcClient } from "./rpc-client.js";
import {
  DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES,
  DEFAULT_MAX_SECONDARY_RUNTIMES,
} from "./runtime-pool.js";
import { SessionIndex } from "./session-index.js";
import { loadWorkspace } from "./workspace-state.js";
import { ensurePiChatSystemGate } from "./system-gate-installer.js";
import {
  buildPiChat,
  cleanupStaleDistArtifacts,
  handOffAfterConfirmedShutdown,
  handOffApplicationRestart,
} from "./application-restart.js";
import { loadBuildIdentity } from "./build-identity.js";
import {
  isIsolatedStreamingBenchmarkRuntime,
  parseBenchmarkSseSnapshotInterval,
} from "./benchmark-streaming-config.js";
import {
  createIncidentDiagnostics,
  recordIncident,
} from "./incident-diagnostics.js";

interface CliOptions {
  host: string;
  port: number;
  cwd: string;
  dev: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    host: process.env.PI_CHAT_HOST || "127.0.0.1",
    port: Number(process.env.PI_CHAT_PORT || 30170),
    // A new installation should create conversations beside ordinary user files,
    // not inside this app's own checkout. CLI/env and a saved user choice still win.
    cwd: process.env.PI_CHAT_CWD || join(homedir(), "Desktop"),
    dev: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dev") options.dev = true;
    else if (arg === "--host" && argv[index + 1]) options.host = argv[++index];
    else if (arg === "--port" && argv[index + 1]) options.port = Number(argv[++index]);
    else if (arg === "--cwd" && argv[index + 1]) options.cwd = resolve(argv[++index]);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("--port 必须是 0 到 65535 之间的整数");
  }
  return options;
}

function findProjectRoot(start: string): string {
  let directory = resolve(start);
  while (true) {
    const isProjectRoot = existsSync(join(directory, "package.json"))
      && (existsSync(join(directory, "src", "web")) || existsSync(join(directory, "dist", "web")));
    if (isProjectRoot) return directory;
    const parent = dirname(directory);
    if (parent === directory) return resolve(process.cwd());
    directory = parent;
  }
}

const options = parseArgs(process.argv.slice(2));
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
// Remote access is intentionally out of scope (no auth/HTTPS/audit).
// Reserved for a future dedicated design — do not reintroduce a half-open host escape hatch.
if (!loopbackHosts.has(options.host)) {
  throw new Error("Pi Chat 当前只支持本机回环监听（127.0.0.1 / localhost / ::1）。远程访问不是当前产品能力；请勿绑定非回环地址或暴露到公网。");
}
options.cwd = await loadWorkspace(options.cwd);
const projectRoot = findProjectRoot(dirname(fileURLToPath(import.meta.url)));
const runtimeDist = process.env.PI_CHAT_RUNTIME_DIST ? resolve(process.env.PI_CHAT_RUNTIME_DIST) : resolve(projectRoot, "dist");
const isolatedStreamingBenchmark = isIsolatedStreamingBenchmarkRuntime({
  configPath: process.env.PI_CHAT_E2E_STREAM_BENCHMARK_CONFIG,
  declaredRuntimeDist: process.env.PI_CHAT_E2E_SERVER_DIST,
  runtimeDist,
  liveDist: resolve(projectRoot, "dist"),
  port: options.port,
});
delete process.env.PI_CHAT_RUNTIME_DIST;
const benchmarkSseSnapshotIntervalMs = parseBenchmarkSseSnapshotInterval(
  process.env.PI_CHAT_BENCHMARK_SSE_INTERVAL_MS,
  isolatedStreamingBenchmark,
);
delete process.env.PI_CHAT_BENCHMARK_SSE_INTERVAL_MS;
if (benchmarkSseSnapshotIntervalMs !== undefined) {
  console.log(`[Pi Chat] benchmark SSE snapshot interval=${benchmarkSseSnapshotIntervalMs}ms`);
}
const protectRollbackBackup = process.env.PI_CHAT_SKIP_STALE_DIST_CLEANUP === "1";
delete process.env.PI_CHAT_SKIP_STALE_DIST_CLEANUP;
const cleaned = protectRollbackBackup ? 0 : await cleanupStaleDistArtifacts(projectRoot);
if (cleaned > 0) console.log(`[Pi Chat] 已清理 ${cleaned} 个残留的 dist 暂存/备份目录。`);
const buildIdentity = await loadBuildIdentity(runtimeDist);
const runEpoch = randomBytes(16).toString("base64url");
const diagnostics = await createIncidentDiagnostics({
  runEpoch,
  revision: buildIdentity.revision !== "unknown"
    ? buildIdentity.revision
    : buildIdentity.fingerprint.slice(0, 12),
});
diagnostics.record({
  runtimeKind: "host",
  operation: "host.start",
  lifecycle: "idle",
  outcome: "started",
});
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const gateComponent = await ensurePiChatSystemGate({
  agentDir,
  sourcePath: join(projectRoot, "resources", "extensions", "pi-chat-file-permission-gate.ts"),
});
if (gateComponent.status === "installed") console.log("[Pi Chat] 已安装内置文件权限安全执行组件。");
if (gateComponent.status === "repaired") console.log("[Pi Chat] 已修复内置文件权限安全执行组件。");
if (gateComponent.status === "conflict" || gateComponent.status === "source-missing") {
  throw new Error(`[Pi Chat] ${gateComponent.diagnostic || "内置文件权限安全执行组件不可用。"}`);
}
let lifecycleForDiagnostics: import("../shared/types.js").ApplicationLifecycle = "idle";
const rpc = new PiRpcClient({
  cwd: options.cwd,
  diagnostics,
  runtimeKind: "primary",
  lifecycle: () => lifecycleForDiagnostics,
});

// Session/JSONL browsing starts independently. This controller is the sole
// owner of Primary start/restart plus compatibility verification. Its App-side
// adoption barrier is installed below before start() can publish ready.
const primaryRuntime = new PrimaryRuntimeReadinessController(rpc, {
  diagnostics,
  lifecycle: () => lifecycleForDiagnostics,
});

let vite: Awaited<ReturnType<typeof import("vite")["createServer"]>> | undefined;
if (options.dev) {
  const { createServer } = await import("vite");
  vite = await createServer({
    configFile: resolve(projectRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });
}

async function prepareApplicationRestart() {
  console.log("[Pi Chat] 正在 staging 目录构建本地更新…");
  const build = await buildPiChat(projectRoot);
  return {
    // Do not rename live dist while this process still holds module handles under it.
    // Promotion runs in restart-handoff after the parent PID exits (Windows EPERM fix).
    promote: async () => {},
    discard: () => build.discard(),
    handoff: () => {
      // Yield one event-loop turn so the browser receives the 202 response before
      // the listener and its SSE streams close.
      setTimeout(() => {
        void handOffAfterConfirmedShutdown(
          () => shutdown("restart-handoff"),
          () => {
            // Start the detached promoter only after every Session writer has a
            // confirmed exit. Otherwise an orphaned old Pi process could overlap
            // the replacement server and mutate the same JSONL.
            handOffApplicationRestart({
              projectRoot,
              // Always hand off to the compiled entry under live dist. After promote,
              // that tree contains the freshly built server; during promote-after-exit
              // the helper swaps dist before spawning this path.
              serverEntry: resolve(projectRoot, "dist", "server", "server", "index.js"),
              host: options.host,
              port: options.port,
              cwd: options.cwd,
              dev: options.dev,
              expectedBuildFingerprint: build.buildFingerprint,
              promoteAfterExit: {
                liveDist: build.liveDist,
                stagedDist: build.distPath,
                previousDist: build.previousDist,
              },
            });
          },
        ).then(() => process.exit(0)).catch((error) => {
          console.error(`[Pi Chat] 重启关闭失败，已取消替代进程：${errorDetail(error)}`);
          process.exitCode = 1;
        });
      }, 0);
    },
  };
}

const app = new PiChatApp({
  rpc,
  // A Secondary Runtime owns its Pi process for its full lifetime. The pool
  // retains at most six idle/active Session runtimes and never rebinds one
  // Session's process to another Session.
  maxSecondaryRuntimes: DEFAULT_MAX_SECONDARY_RUNTIMES,
  maxIdleSecondaryRuntimes: DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES,
  createRpc: (cwd) => new PiRpcClient({
    cwd,
    diagnostics,
    runtimeKind: "secondary",
    lifecycle: () => lifecycleForDiagnostics,
  }),
  sessions: new SessionIndex(),
  resources: new ResourceManager(),
  modelManager: new ModelManager(),
  cwd: options.cwd,
  webRoot: resolve(runtimeDist, "web"),
  devMiddleware: vite ? (request, response, next) => vite.middlewares(request, response, next) : undefined,
  allowedHosts: [],
  applicationRestart: prepareApplicationRestart,
  applicationShutdown: (reason) => setTimeout(() => void shutdown(reason).then(
    () => {
      if (!fatalShutdownRequested) process.exit(0);
    },
    (error) => {
      console.error(`[Pi Chat] 应用关闭失败：${errorDetail(error)}`);
      process.exitCode = 1;
    },
  ), 0),
  primaryRuntime,
  buildIdentity,
  runEpoch,
  diagnostics,
  sseSnapshotIntervalMs: benchmarkSseSnapshotIntervalMs,
});
console.log("[Pi Chat] 正在准备 Pi Runtime…");
const primaryStartup = primaryRuntime.start();
void primaryStartup.then(() => {
  console.log("[Pi Chat] Pi Runtime 已就绪。");
  diagnostics.record({
    runtimeKind: "primary",
    rpcGeneration: rpc.currentGeneration(),
    childPid: rpc.currentPid() || undefined,
    operation: "host.ready",
    lifecycle: "idle",
    outcome: "succeeded",
  });
}).catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  console.error(`[Pi Chat] Pi Runtime 暂不可用：${error.message}`);
});

const server = createHttpServer((request, response) => void app.handle(request, response));

await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(options.port, options.host, () => resolveListen());
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : options.port;
const authority = options.host.includes(":") ? `[${options.host}]:${port}` : `${options.host}:${port}`;
app.setAllowedHosts([authority]);
console.log(`[Pi Chat] 已启动：http://${options.host}:${port}`);
type ShutdownReason = "sigint" | "sigterm" | "api-shutdown" | "last-window-close" | "restart-handoff" | "uncaught-exception" | "unhandled-rejection";
const FATAL_SHUTDOWN_TIMEOUT_MS = 15_000;

let shutdownPromise: Promise<void> | null = null;
let fatalShutdownRequested = false;

function errorDetail(error: unknown): string {
  return error instanceof Error ? (error.stack || error.message) : String(error);
}

async function shutdownStep(name: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    // A best-effort close must not prevent later steps from freeing the HTTP
    // listener or Pi child. The original fatal error is already in stderr.
    console.error(`[Pi Chat] 关闭步骤失败（${name}）：${errorDetail(error)}`);
  }
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function shutdown(reason: ShutdownReason): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  console.log(`\n[Pi Chat] 正在关闭（reason=${reason}）…`);
  lifecycleForDiagnostics = reason === "restart-handoff"
    ? "restarting"
    : "shutting-down";
  shutdownPromise = (async () => {
    const errors: Error[] = [];
    const requiredStop = async (name: string, action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        errors.push(normalized);
        console.error(`[Pi Chat] 关闭步骤失败（${name}）：${errorDetail(normalized)}`);
      }
    };
    // End SSE clients and secondary workers before server.close(): Node waits
    // for long-lived SSE connections, so closing the listener first can
    // deadlock a self-restart indefinitely. Unlike disposable HTTP/Vite close
    // errors, unconfirmed Pi child exits are hard barriers to replacement.
    await requiredStop("应用", () => app.close());
    await shutdownStep("HTTP", closeHttpServer);
    await shutdownStep("Vite", async () => {
      await vite?.close();
    });
    // If shutdown races initial spawn, wait for it before the final stop.
    await primaryStartup.catch(() => undefined);
    await requiredStop("Primary Pi RPC", () => rpc.stop());
    if (errors.length) {
      const failure = errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "一个或多个 Pi RPC 进程退出无法确认");
      recordIncident(diagnostics, failure, {
        runtimeKind: "host",
        operation: "host.shutdown",
        lifecycle: lifecycleForDiagnostics,
        outcome: "failed",
        errorCode: "HOST_SHUTDOWN_FAILED",
      });
      await diagnostics.flush();
      throw failure;
    }
    diagnostics.record({
      runtimeKind: "host",
      operation: "host.shutdown",
      lifecycle: lifecycleForDiagnostics,
      outcome: "succeeded",
    });
    await diagnostics.close();
  })();
  return shutdownPromise;
}

/** Unknown process-level failures cannot safely leave a mutable chat service running. */
function fatalShutdown(
  reason: "uncaught-exception" | "unhandled-rejection",
  error: unknown,
): void {
  if (fatalShutdownRequested) return;
  fatalShutdownRequested = true;
  process.exitCode = 1;
  const label =
    reason === "unhandled-rejection" ? "未处理的 Promise 拒绝" : "未捕获异常";
  console.error(`[Pi Chat] ${label}：${errorDetail(error)}`);
  const deadline = setTimeout(() => {
    console.error(`[Pi Chat] 致命异常关闭超过 ${FATAL_SHUTDOWN_TIMEOUT_MS}ms，强制退出`);
    try {
      server.closeAllConnections();
    } catch {
      // The process exits immediately below; never recurse through another
      // uncaughtException while reporting a terminal close failure.
    }
    process.exit(1);
  }, FATAL_SHUTDOWN_TIMEOUT_MS);
  deadline.unref();
  void shutdown(reason).then(
    () => {
      clearTimeout(deadline);
      process.exit(1);
    },
    (shutdownError) => {
      clearTimeout(deadline);
      console.error(`[Pi Chat] 致命异常关闭失败：${errorDetail(shutdownError)}`);
      process.exit(1);
    },
  );
}

// Node ≥15 otherwise promotes an unhandled rejection to a fatal exception.
// Handle both process-level failure modes through one bounded close sequence;
// event listener isolation belongs in PiRpcClient, not this last-resort path.
process.on("unhandledRejection", (reason) =>
  fatalShutdown("unhandled-rejection", reason),
);
process.on("uncaughtException", (error) =>
  fatalShutdown("uncaught-exception", error),
);

function signalShutdown(reason: "sigint" | "sigterm"): void {
  void shutdown(reason).then(
    () => {
      if (!fatalShutdownRequested) process.exit(0);
    },
    (error) => {
      console.error(`[Pi Chat] 信号关闭失败：${errorDetail(error)}`);
      process.exitCode = 1;
    },
  );
}

process.once("SIGINT", () => signalShutdown("sigint"));
process.once("SIGTERM", () => signalShutdown("sigterm"));
