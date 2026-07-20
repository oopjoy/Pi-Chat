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
import { ensureBundledExtension, ensurePiChatTodoExtension } from "./todo-extension-installer.js";

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
options.cwd = await loadWorkspace(options.cwd);
const projectRoot = findProjectRoot(dirname(fileURLToPath(import.meta.url)));
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const todoExtension = await ensurePiChatTodoExtension({
  agentDir,
  sourcePath: join(projectRoot, "resources", "extensions", "pi-chat-todo.ts"),
});
if (todoExtension === "installed") console.log("[Pi Chat] 已安装内置 Todo 扩展。");
if (todoExtension === "source-missing") console.warn("[Pi Chat] 未找到内置 Todo 扩展；待办面板仍可读取已有状态，但无法提供 /todo 工具。");
const gateExtension = await ensureBundledExtension({
  agentDir,
  sourcePath: join(projectRoot, "resources", "extensions", "pi-chat-file-permission-gate.ts"),
  targetName: "pi-chat-file-permission-gate.ts",
  legacyNames: ["file-permission-gate.ts"],
});
if (gateExtension === "installed") console.log("[Pi Chat] 已安装内置文件权限 Gate 扩展。");
if (gateExtension === "source-missing") console.warn("[Pi Chat] 未找到内置文件权限 Gate 扩展；文件权限控制器不可用。");
const rpc = new PiRpcClient({ cwd: options.cwd });

console.log("[Pi Chat] 正在启动 Pi RPC…");
await rpc.start();

let vite: Awaited<ReturnType<typeof import("vite")["createServer"]>> | undefined;
if (options.dev) {
  const { createServer } = await import("vite");
  vite = await createServer({
    configFile: resolve(projectRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });
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
});
const server = createHttpServer((request, response) => void app.handle(request, response));

await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(options.port, options.host, () => resolveListen());
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : options.port;
console.log(`[Pi Chat] 已启动：http://${options.host}:${port}`);
void app.preheatRecentSessions().then((ids) => {
  if (ids.length) console.log(`[Pi Chat] 已后台预热最近 ${ids.length} 个历史会话。`);
}).catch((error) => console.warn(`[Pi Chat] 历史会话预热失败：${error instanceof Error ? error.message : String(error)}`));
if (options.host !== "127.0.0.1" && options.host !== "localhost" && options.host !== "::1") {
  console.warn("[Pi Chat] 警告：基础版尚未实现远程登录认证，请勿直接暴露到公网。");
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[Pi Chat] 正在关闭…");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await app.close();
  await vite?.close();
  await rpc.stop();
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
