import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureBundledExtension, ensurePiChatTodoExtension } from "../src/server/todo-extension-installer";

test("bundled Todo extension installs once without replacing existing implementations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-todo-installer-"));
  try {
    const source = join(root, "pi-chat-todo.ts");
    const agent = join(root, "agent");
    await writeFile(source, "export default function bundledTodo() {}\n");

    assert.equal(await ensurePiChatTodoExtension({ agentDir: agent, sourcePath: source }), "installed");
    const installed = join(agent, "extensions", "pi-chat-todo.ts");
    assert.equal(await readFile(installed, "utf8"), "export default function bundledTodo() {}\n");
    await writeFile(source, "changed source\n");
    assert.equal(await ensurePiChatTodoExtension({ agentDir: agent, sourcePath: source }), "already-installed");
    assert.equal(await readFile(installed, "utf8"), "export default function bundledTodo() {}\n");

    const legacyAgent = join(root, "legacy-agent");
    await mkdir(join(legacyAgent, "extensions"), { recursive: true });
    await writeFile(join(legacyAgent, "extensions", "local-todo.ts"), "legacy todo\n");
    assert.equal(await ensurePiChatTodoExtension({ agentDir: legacyAgent, sourcePath: source }), "legacy-extension");
    await assert.rejects(readFile(join(legacyAgent, "extensions", "pi-chat-todo.ts"), "utf8"));

    const gateAgent = join(root, "gate-agent");
    const gateSource = join(root, "pi-chat-file-permission-gate.ts");
    await writeFile(gateSource, "export default function bundledGate() {}\n");
    assert.equal(await ensureBundledExtension({ agentDir: gateAgent, sourcePath: gateSource, targetName: "pi-chat-file-permission-gate.ts", legacyNames: ["file-permission-gate.ts"] }), "installed");
    assert.equal(await readFile(join(gateAgent, "extensions", "pi-chat-file-permission-gate.ts"), "utf8"), "export default function bundledGate() {}\n");
    const existingGateAgent = join(root, "existing-gate-agent");
    await mkdir(join(existingGateAgent, "extensions"), { recursive: true });
    await writeFile(join(existingGateAgent, "extensions", "file-permission-gate.ts"), "existing gate\n");
    assert.equal(await ensureBundledExtension({ agentDir: existingGateAgent, sourcePath: gateSource, targetName: "pi-chat-file-permission-gate.ts", legacyNames: ["file-permission-gate.ts"] }), "legacy-extension");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
