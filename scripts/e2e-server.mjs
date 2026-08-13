import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { e2eSessionIdForPath, importE2eSessionFixtures } from "./e2e-fixture-import.mjs";
import { observeOwnedProcess, terminateOwnedProcessTree } from "./e2e-process-tree.mjs";
import { e2eRuntimeDist } from "./e2e-runtime-dist.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeDist = e2eRuntimeDist(process.env, projectRoot);
const serverDist = resolve(process.env.PI_CHAT_E2E_SERVER_DIST || runtimeDist);
const portIndex = process.argv.indexOf("--port");
const fixtureDirectoryIndex = process.argv.indexOf("--fixture-dir");
const fixtureManifestIndex = process.argv.indexOf("--fixture-manifest");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 30179;
const fixtureDirectory = fixtureDirectoryIndex >= 0 ? process.argv[fixtureDirectoryIndex + 1] : "";
const fixtureManifestPath = fixtureManifestIndex >= 0 ? process.argv[fixtureManifestIndex + 1] : "";
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("E2E 端口无效");
if (fixtureDirectory && !fixtureManifestPath) throw new Error("显式 E2E fixture 导入需要 manifest 输出路径");
if (!fixtureDirectory && fixtureManifestPath) throw new Error("E2E fixture manifest 只能与 fixture 目录一起使用");
const root = await mkdtemp(join(tmpdir(), "pi-chat-e2e-"));
const sessions = join(root, "sessions");
const agentDir = join(root, "agent");
const rpcEntry = join(root, "fake-rpc.mjs");
await mkdir(sessions, { recursive: true });
await mkdir(agentDir, { recursive: true });

const session = (path, id, name, prompt, answer, model = "gpt-test") => writeFile(path, [
  { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd: root },
  { type: "session_info", id: `${id}-name`, parentId: null, name },
  { type: "message", id: `${id}-user`, parentId: `${id}-name`, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: prompt, timestamp: Date.parse("2026-01-01T00:00:01Z") } },
  { type: "message", id: `${id}-assistant`, parentId: `${id}-user`, timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", provider: "test", model, content: answer, timestamp: Date.parse("2026-01-01T00:00:02Z") } },
].map(JSON.stringify).join("\n") + "\n", "utf8");

await session(join(sessions, "first.jsonl"), "first", "First session", "Open first", "First answer");
await writeFile(join(sessions, "second.jsonl"), [
  { type: "session", version: 3, id: "second", timestamp: "2026-01-02T00:00:00Z", cwd: root },
  { type: "session_info", id: "second-name", parentId: null, name: "Second session" },
  { type: "message", id: "second-user", parentId: "second-name", timestamp: "2026-01-02T00:00:01Z", message: { role: "user", content: "Inspect edit", timestamp: Date.parse("2026-01-02T00:00:01Z") } },
  { type: "message", id: "second-process", parentId: "second-user", timestamp: "2026-01-02T00:00:02Z", message: { role: "assistant", provider: "test", model: "gpt-e2e", timestamp: Date.parse("2026-01-02T00:00:02Z"), content: [
    { type: "thinking", thinking: "A deliberately visible process thought for the browser test." },
    { type: "toolCall", id: "edit-e2e", name: "edit", arguments: { path: "src/example.ts", edits: [{ oldText: "const oldValue = 1;", newText: "const newValue = 2;" }] } },
  ] } },
  { type: "message", id: "second-result", parentId: "second-process", timestamp: "2026-01-02T00:00:03Z", message: { role: "toolResult", toolCallId: "edit-e2e", toolName: "edit", content: "Successfully replaced 1 block(s)" } },
  { type: "message", id: "second-image", parentId: "second-result", timestamp: "2026-01-02T00:00:04Z", message: { role: "user", timestamp: Date.parse("2026-01-02T00:00:04Z"), content: [{ type: "image", mimeType: "image/svg+xml", data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="1800"><rect width="100%" height="100%" fill="#78b8f5"/><text x="1600" y="900" text-anchor="middle" dominant-baseline="middle" font-size="160" fill="#182131">Preview fixture</text></svg>').toString("base64") }] } },
  { type: "message", id: "second-answer", parentId: "second-image", timestamp: "2026-01-02T00:00:05Z", message: { role: "assistant", provider: "test", model: "gpt-e2e", timestamp: Date.parse("2026-01-02T00:00:05Z"), content: "Final **answer** with `$x = 1$`." } },
].map(JSON.stringify).join("\n") + "\n", "utf8");

const importedFixtures = fixtureDirectory
  ? await importE2eSessionFixtures(fixtureDirectory, sessions)
  : [];
if (fixtureManifestPath) {
  await writeFile(
    resolve(fixtureManifestPath),
    `${JSON.stringify({
      sessions: importedFixtures.map((name) => ({
        name,
        id: e2eSessionIdForPath(join(sessions, name)),
      })),
    }, null, 2)}\n`,
    "utf8",
  );
}

await writeFile(rpcEntry, String.raw`
import { createInterface } from "node:readline";
import { basename, extname } from "node:path";
const sessionIndex = process.argv.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : process.env.PI_CHAT_E2E_ACTIVE;
const sessionId = basename(sessionFile, extname(sessionFile));
let isStreaming = false;
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, data) => write({ type: "response", id, success: true, data });
const handlers = {
  get_state: () => ({ model: { provider: "test", id: "gpt-e2e", name: "E2E Model", input: ["text"] }, isStreaming, sessionId, sessionFile }),
  get_messages: () => ({ messages: [] }),
  get_available_models: () => ({ models: [
    { provider: "test", id: "gpt-e2e", name: "E2E Model", input: ["text"] },
    { provider: "test", id: "gpt-e2e-alt", name: "Alternate E2E Model", input: ["text"] },
  ] }),
  get_commands: () => ({ commands: [] }),
  get_session_stats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "prompt") {
    isStreaming = true;
    write({ type: "agent_start" });
    reply(command.id, {});
    setTimeout(() => {
      write({ type: "message_start", message: { role: "assistant", provider: "test", model: "gpt-e2e", content: "Live response complete" } });
      write({ type: "message_end", message: { role: "assistant", provider: "test", model: "gpt-e2e", content: "Live response complete" } });
      isStreaming = false;
      write({ type: "agent_settled" });
    }, 80);
    return;
  }
  reply(command.id, handlers[command.type]?.() || {});
});
`, "utf8");

const child = spawn(process.execPath, [join(serverDist, "server", "server", "index.js"), "--host", "127.0.0.1", "--port", String(port), "--cwd", root], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PI_CHAT_RUNTIME_DIST: runtimeDist,
    PI_CHAT_PI_ENTRY: rpcEntry,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_CHAT_E2E_ACTIVE: join(sessions, "first.jsonl"),
  },
  stdio: "inherit",
  windowsHide: true,
});
const observedChild = observeOwnedProcess(child);

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const removeRoot = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code) || attempt === 7) return;
      await delay(80 * (attempt + 1));
    }
  }
};

let cleaning = false;
const cleanup = async () => {
  if (cleaning) return;
  cleaning = true;
  let failure;
  try {
    await terminateOwnedProcessTree(observedChild, 5_000);
  } catch (error) {
    failure = error;
  }
  await removeRoot();
  if (failure) throw failure;
};
const closeFromSignal = () => void cleanup().then(
  () => process.exit(0),
  (error) => {
    console.error(`[Pi Chat E2E] 子进程树退出无法确认：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
process.once("SIGINT", closeFromSignal);
process.once("SIGTERM", closeFromSignal);
child.once("exit", (code) => {
  if (cleaning) return;
  void removeRoot().then(() => process.exit(code || 0));
});
