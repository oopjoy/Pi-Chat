import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePiChatSystemGate, PI_CHAT_GATE_MARKER, PI_CHAT_GATE_TARGET } from "../src/server/system-gate-installer";

const source = (version = "1") => `/**\n * ${PI_CHAT_GATE_MARKER.replace("version: 1", `version: ${version}`)}\n */\n\nexport default function gate() {}\n`;
const legacy = () => `/** legacy banner */\n\nexport default function gate() {}\n`;

test("Pi Chat system Gate installs, self-heals, and remains explicitly enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-system-gate-"));
  try {
    const agentDir = join(root, "agent");
    const sourcePath = join(root, "gate.ts");
    await writeFile(sourcePath, source());
    assert.equal((await ensurePiChatSystemGate({ agentDir, sourcePath })).status, "installed");
    const target = join(agentDir, "extensions", PI_CHAT_GATE_TARGET);
    assert.equal(await readFile(target, "utf8"), source());
    assert.match(await readFile(join(agentDir, "settings.json"), "utf8"), /\+extensions\/pi-chat-file-permission-gate\.ts/);
    await writeFile(target, `${source()}// damaged\n`);
    assert.equal((await ensurePiChatSystemGate({ agentDir, sourcePath })).status, "repaired");
    assert.equal(await readFile(target, "utf8"), source());
    assert.equal((await ensurePiChatSystemGate({ agentDir, sourcePath })).status, "verified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("system Gate migrates its old equivalent adapter but preserves custom legacy Gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-system-gate-legacy-"));
  try {
    const sourcePath = join(root, "gate.ts");
    await writeFile(sourcePath, source());
    const equivalentAgent = join(root, "equivalent");
    await mkdir(join(equivalentAgent, "extensions"), { recursive: true });
    await writeFile(join(equivalentAgent, "extensions", "file-permission-gate.ts"), legacy());
    // The bodies after their banners are equivalent; migration makes the generic
    // legacy name inert before installing the Pi Chat-owned component.
    assert.equal((await ensurePiChatSystemGate({ agentDir: equivalentAgent, sourcePath })).status, "installed");
    assert.match(await readFile(join(equivalentAgent, "extensions", "file-permission-gate.ts.pi-chat-legacy-disabled"), "utf8"), /legacy banner/);

    const customAgent = join(root, "custom");
    await mkdir(join(customAgent, "extensions"), { recursive: true });
    await writeFile(join(customAgent, "extensions", "file-permission-gate.ts"), "export default function customGate() {}\n");
    const conflict = await ensurePiChatSystemGate({ agentDir: customAgent, sourcePath });
    assert.equal(conflict.status, "conflict");
    assert.match(conflict.diagnostic || "", /自定义旧版/);
    assert.equal(await readFile(join(customAgent, "extensions", "file-permission-gate.ts"), "utf8"), "export default function customGate() {}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
