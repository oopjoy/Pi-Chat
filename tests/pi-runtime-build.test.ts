import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { PiRpcClient, rpcData } from "../src/server/rpc-client";
import type { IncidentDiagnostics, IncidentFields } from "../src/server/incident-diagnostics";

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function findPiPackageRoot(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: unknown };
      if (manifest.name === "@earendil-works/pi-coding-agent") return directory;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Pi package root is unavailable");
    directory = parent;
  }
}

test("Pi Runtime build emits a relocatable independent RPC artifact", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-runtime-build-"));
  const piPackageRoot = await findPiPackageRoot();
  try {
    await execFile(process.execPath, ["scripts/build-pi-runtime.mjs"], {
      cwd: projectRoot,
      env: { ...process.env, PI_CHAT_DIST_DIR: root },
      timeout: 90_000,
      windowsHide: true,
    });
    const runtimeRoot = join(root, "resources", "pi-runtime");
    const manifest = JSON.parse(await readFile(join(runtimeRoot, "manifest.json"), "utf8")) as {
      schemaVersion?: number;
      piVersion?: string;
      recipeVersion?: number;
      esbuildVersion?: string;
      bundleRelativePath?: string;
      sourceInputs?: unknown[];
      outputHashes?: Record<string, string>;
    };
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.piVersion, "0.85.1");
    assert.equal(manifest.recipeVersion, 4);
    assert.equal(manifest.esbuildVersion, "0.28.1");
    assert.ok((manifest.sourceInputs?.length ?? 0) > 1_000);
    assert.equal(manifest.bundleRelativePath, "package/dist/rpc-entry.bundle.mjs");
    for (const path of Object.keys(manifest.outputHashes ?? {})) await access(join(runtimeRoot, path));
    const bundleSource = await readFile(join(runtimeRoot, "package", "dist", "rpc-entry.bundle.mjs"), "utf8");
    assert.match(bundleSource, /case "dequeue"/);
    assert.match(bundleSource, /pi_chat_queue_dequeued/);
    const imageWorkerPath = join(runtimeRoot, "package", "dist", "image-resize-worker.js");
    await access(imageWorkerPath);
    await access(join(runtimeRoot, "package", "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"));
    const wrapperResult = await execFile(
      process.execPath,
      [join(runtimeRoot, "package", "dist", "cli.js"), "--version"],
      {
        cwd: projectRoot,
        env: { ...process.env, PI_CHAT_ORIGINAL_PI_CLI: join(piPackageRoot, "dist", "cli.js") },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert.equal(wrapperResult.stdout.trim(), "0.85.1");
    const imageWorker = new Worker(pathToFileURL(imageWorkerPath));
    try {
      const imageResult = new Promise<Record<string, unknown>>((resolveMessage, rejectMessage) => {
        imageWorker.once("message", resolveMessage);
        imageWorker.once("error", rejectMessage);
      });
      imageWorker.postMessage({
        inputBytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"),
        mimeType: "image/png",
      });
      const response = await imageResult as { result?: { width?: unknown; height?: unknown; data?: unknown; wasResized?: unknown } | null };
      assert.ok(response.result);
      assert.equal(response.result.width, 1);
      assert.equal(response.result.height, 1);
      assert.equal(typeof response.result.data, "string");
      assert.equal(response.result.wasResized, false);
    } finally {
      await imageWorker.terminate();
    }

    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const extensionPath = join(root, "bundle-parity-extension.ts");
    await writeFile(extensionPath, `
import * as CurrentPi from "@earendil-works/pi-coding-agent";
import * as LegacyPi from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function bundleParity(pi: any) {
  if (!CurrentPi.SessionManager || !LegacyPi.SessionManager) throw new Error("Pi alias parity failed");
  pi.registerCommand("bundle_parity", {
    description: "Bundle alias parity",
    handler: async () => undefined,
  });
  pi.registerTool({
    name: "bundle_parity_tool",
    label: "Bundle parity",
    description: "Bundle alias parity tool",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  });
}
`, "utf8");
    const startupRecords: IncidentFields[] = [];
    const diagnostics: IncidentDiagnostics = {
      directory: null,
      hostId: "test",
      record(fields) {
        startupRecords.push(fields);
        return { incidentId: "PC-TEST0001" };
      },
      flush: async () => {},
      close: async () => {},
    };
    const client = new PiRpcClient({
      cwd: projectRoot,
      piEntry: join(runtimeRoot, "package", "dist", "rpc-entry.bundle.mjs"),
      startupProbe: join(projectRoot, "resources", "runtime", "pi-chat-startup-probe.mjs"),
      diagnostics,
      childEnvironment: {
        PI_CHAT_BUNDLED_RUNTIME: "1",
        PI_CODING_AGENT_DIR: agentDir,
        PI_CHAT_ORIGINAL_PI_CLI: join(piPackageRoot, "dist", "cli.js"),
        PI_PACKAGE_DIR: piPackageRoot,
        PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: piPackageRoot,
      },
      args: [
        "--no-session",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--extension",
        extensionPath,
        "--extension",
        join(projectRoot, "resources", "extensions", "pi-chat-file-permission-gate.ts"),
      ],
    });
    try {
      await client.start();
      const state = rpcData<{ isStreaming: boolean }>(await client.send({ type: "get_state" }));
      assert.equal(state.isStreaming, false);
      const importEnds = startupRecords.filter((record) => record.startupPhase === "extension-import-end");
      const factoryEnds = startupRecords.filter((record) => record.startupPhase === "extension-factory-end");
      assert.ok(importEnds.length >= 2, "Bundle startup should report each imported Extension ordinal");
      assert.ok(factoryEnds.length >= 2, "Bundle startup should report each Extension factory ordinal");
      assert.ok(importEnds.every((record) => (record.extensionOrdinal ?? 0) >= 1));
      assert.ok(importEnds.every((record) => (record.extensionImportDurationMs ?? -1) >= 0));
      assert.ok(factoryEnds.every((record) => (record.extensionFactoryDurationMs ?? -1) >= 0));
      const slowStartup = startupRecords.filter((record) => record.startupPhase === "startup-slow-observed");
      assert.equal(slowStartup.length, 0, "the fixture Bundle must not trigger the slow-start watchdog");
      const dequeued = rpcData<{ steering: string[]; followUp: string[] }>(await client.send({
        type: "dequeue",
        dequeueId: "44444444-4444-4444-8444-444444444444",
      }));
      assert.deepEqual(dequeued, { steering: [], followUp: [] });
      const commands = rpcData<{ commands: Array<{ name?: string }> }>(await client.send({ type: "get_commands" }));
      const commandNames = new Set(commands.commands.map((command) => command.name));
      assert.equal(commandNames.has("bundle_parity"), true);
      assert.equal(commandNames.has("gate"), true);
    } finally {
      await client.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
