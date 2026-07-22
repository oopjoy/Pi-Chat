#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiChatApp } from "./app.js";
import { ModelManager } from "./model-manager.js";
import { ResourceManager } from "./resource-manager.js";
import { PiRpcClient } from "./rpc-client.js";
import { SessionIndex } from "./session-index.js";
import { loadWorkspace } from "./workspace-state.js";
import { ensurePiChatSystemGate } from "./system-gate-installer.js";
import { buildPiChat, handOffApplicationRestart } from "./application-restart.js";

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
if (!loopbackHosts.has(options.host) && process.env.PI_CHAT_ALLOW_REMOTE !== "1") {
  throw new Error("基础版 Pi Chat 尚未实现远程认证。为避免未授权访问，非回环监听需要显式设置 PI_CHAT_ALLOW_REMOTE=1。");
}
options.cwd = await loadWorkspace(options.cwd);
const projectRoot = findProjectRoot(dirname(fileURLToPath(import.meta.url)));
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

console.log("[Pi Chat] 正在启动 Pi RPC…");
await rpc.start();
const compatibility = await rpc.probeCompatibility();
if (!compatibility.compatible) {
  await rpc.stop();
  throw new Error(`当前 Pi RPC 协议不兼容 Pi Chat：\n- ${compatibility.diagnostics.join("\n- ")}\n请更新 Pi，或使用兼容的 Pi Chat 版本。`);
}

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
    promote: () => build.promote(),
    discard: () => build.discard(),
    handoff: () => {
      // Yield one event-loop turn so the browser receives the 202 response before
      // the listener and its SSE streams close.
      setTimeout(() => {
        handOffApplicationRestart({
          projectRoot,
          serverEntry: fileURLToPath(import.meta.url),
          host: options.host,
          port: options.port,
          cwd: options.cwd,
          dev: options.dev,
        });
        void shutdown().then(() => process.exit(0));
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
  webRoot: resolve(projectRoot, "dist", "web"),
  devMiddleware: vite ? (request, response, next) => vite.middlewares(request, response, next) : undefined,
  allowedHosts: [],
  applicationRestart: prepareApplicationRestart,
  applicationShutdown: () => setTimeout(() => void shutdown().then(() => process.exit(0)), 0),
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
void app.preheatRecentSessions().then((ids) => {
  if (ids.length) console.log(`[Pi Chat] 已后台预热最近 ${ids.length} 个历史会话。`);
}).catch((error) => console.warn(`[Pi Chat] 历史会话预热失败：${error instanceof Error ? error.message : String(error)}`));
if (!loopbackHosts.has(options.host)) {
  console.warn("[Pi Chat] 警告：已显式启用未认证远程监听；只可在受信任网络中临时使用，严禁暴露到公网。");
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[Pi Chat] 正在关闭…");
  // End SSE clients and secondary workers before server.close(): Node waits for
  // long-lived SSE connections, so closing the listener first can deadlock a
  // self-restart indefinitely.
  await app.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await vite?.close();
  await rpc.stop();
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
