#!/usr/bin/env node
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
import { SessionIndex } from "./session-index.js";
import { loadWorkspace } from "./workspace-state.js";
import { ensurePiChatSystemGate } from "./system-gate-installer.js";
import { buildPiChat, cleanupStaleDistArtifacts, handOffApplicationRestart } from "./application-restart.js";

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
    cwd: process.env.PI_CHAT_CWD || homedir(),
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
delete process.env.PI_CHAT_RUNTIME_DIST;
const protectRollbackBackup = process.env.PI_CHAT_SKIP_STALE_DIST_CLEANUP === "1";
delete process.env.PI_CHAT_SKIP_STALE_DIST_CLEANUP;
const cleaned = protectRollbackBackup ? 0 : await cleanupStaleDistArtifacts(projectRoot);
if (cleaned > 0) console.log(`[Pi Chat] 已清理 ${cleaned} 个残留的 dist 暂存/备份目录。`);
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
const rpc = new PiRpcClient({ cwd: options.cwd });

// Session/JSONL browsing starts independently. This controller is the sole
// owner of Primary start/restart plus compatibility verification.
const primaryRuntime = new PrimaryRuntimeReadinessController(rpc);
console.log("[Pi Chat] 正在准备 Pi Runtime…");
const primaryStartup = primaryRuntime.start();
void primaryStartup.then(() => console.log("[Pi Chat] Pi Runtime 已就绪。")).catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  console.error(`[Pi Chat] Pi Runtime 暂不可用：${error.message}`);
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
          promoteAfterExit: {
            liveDist: build.liveDist,
            stagedDist: build.distPath,
            previousDist: build.previousDist,
          },
        });
        void shutdown("restart-handoff").then(() => process.exit(0));
      }, 0);
    },
  };
}

const app = new PiChatApp({
  rpc,
  createRpc: (cwd) => new PiRpcClient({ cwd }),
  sessions: new SessionIndex(),
  resources: new ResourceManager(),
  modelManager: new ModelManager(),
  cwd: options.cwd,
  webRoot: resolve(runtimeDist, "web"),
  devMiddleware: vite ? (request, response, next) => vite.middlewares(request, response, next) : undefined,
  allowedHosts: [],
  applicationRestart: prepareApplicationRestart,
  applicationShutdown: (reason) => setTimeout(() => void shutdown(reason).then(() => process.exit(0)), 0),
  primaryRuntime,
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

type ShutdownReason = "sigint" | "sigterm" | "api-shutdown" | "last-window-close" | "restart-handoff";

let shuttingDown = false;
async function shutdown(reason: ShutdownReason): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Pi Chat] 正在关闭（reason=${reason}）…`);
  // End SSE clients and secondary workers before server.close(): Node waits for
  // long-lived SSE connections, so closing the listener first can deadlock a
  // self-restart indefinitely.
  await app.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await vite?.close();
  // If shutdown races initial spawn, wait for it before the final bounded stop.
  await primaryStartup.catch(() => undefined);
  await rpc.stop();
}

process.once("SIGINT", () => void shutdown("sigint").then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("sigterm").then(() => process.exit(0)));
