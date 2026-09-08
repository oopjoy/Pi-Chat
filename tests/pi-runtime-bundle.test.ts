import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePiRuntimeLaunch } from "../src/server/pi-runtime-bundle";
import { PiRpcClient, resolvePiEntry } from "../src/server/rpc-client";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-runtime-plan-"));
  const appData = join(root, "appdata");
  const packageRoot = join(appData, "npm", "node_modules", "@earendil-works", "pi-coding-agent");
  const runtimeDist = join(root, "dist");
  const runtimeRoot = join(runtimeDist, "resources", "pi-runtime");
  const sourceFiles: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.85.1",
      type: "module",
      bin: { pi: "dist/cli.js" },
    }),
    "dist/rpc-entry.js": "// rpc entry\n",
    "dist/main.js": "// main\n",
    "dist/core/agent-session-runtime.js": "// runtime\n",
    "dist/core/agent-session.js": "// session\n",
    "dist/core/extensions/loader.js": "// loader\n",
    "dist/cli.js": "// cli\n",
  };
  for (const [path, content] of Object.entries(sourceFiles)) {
    const file = join(packageRoot, path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content);
  }
  const outputs: Record<string, string> = {
    "package/dist/rpc-entry.bundle.mjs": "// bundle\n",
    "package/dist/image-resize-worker.js": "// worker\n",
    "package/dist/cli.js": "// wrapper\n",
    "package/package.json": "{}\n",
  };
  for (const [path, content] of Object.entries(outputs)) {
    const file = join(runtimeRoot, path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content);
  }
  const sourceInputs = Object.entries(sourceFiles)
    .filter(([path]) => path !== "dist/cli.js")
    .map(([relativePath, content]) => ({
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion: "0.85.1",
      packageLocator: ".",
      relativePath,
      sha256: sha256(content),
    }));
  const outputHashes = Object.fromEntries(
    Object.entries(outputs).map(([path, content]) => [path, sha256(content)]),
  );
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "manifest.json"), JSON.stringify({
    schemaVersion: 2,
    layoutVersion: 1,
    piPackageName: "@earendil-works/pi-coding-agent",
    piVersion: "0.85.1",
    minimumNodeMajor: 22,
    supportedPlatforms: [process.platform],
    supportedArchitectures: [process.arch],
    bundleRelativePath: "package/dist/rpc-entry.bundle.mjs",
    bundleSha256: outputHashes["package/dist/rpc-entry.bundle.mjs"],
    originalCliRelativePath: "dist/cli.js",
    recipeVersion: 4,
    esbuildVersion: "0.28.1",
    sourceInputs,
    outputHashes,
  }));
  return {
    root,
    runtimeDist,
    packageRoot,
    rpcEntry: join(packageRoot, "dist", "rpc-entry.js"),
    env: { APPDATA: appData, PATH: "" } as NodeJS.ProcessEnv,
  };
}

test("runtime launch selects one fingerprint-matched independent RPC bundle", async () => {
  const value = await fixture();
  try {
    const plan = await resolvePiRuntimeLaunch({ runtimeDist: value.runtimeDist, env: value.env });
    assert.equal(plan.bundled, true);
    assert.match(plan.piEntry, /rpc-entry\.bundle\.mjs$/);
    assert.equal(plan.childEnvironment.PI_CHAT_BUNDLED_RUNTIME, "1");
    assert.equal(plan.childEnvironment.PI_PACKAGE_DIR, value.packageRoot);
    assert.equal(plan.childEnvironment.PI_CHAT_ORIGINAL_PI_ENTRY, value.rpcEntry);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("runtime launch falls back to the frozen direct entry on source or output mismatch", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.packageRoot, "dist", "main.js"), "// changed\n");
    const sourceMismatch = await resolvePiRuntimeLaunch({ runtimeDist: value.runtimeDist, env: value.env });
    assert.equal(sourceMismatch.bundled, false);
    assert.equal(sourceMismatch.piEntry, value.rpcEntry);
    assert.match(sourceMismatch.diagnostic, /source fingerprint/);

    await writeFile(join(value.packageRoot, "dist", "main.js"), "// main\n");
    const manifestPath = join(value.runtimeDist, "resources", "pi-runtime", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { outputHashes: Record<string, string> };
    manifest.outputHashes["package/dist/image-resize-worker.js"] = "0".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const outputMismatch = await resolvePiRuntimeLaunch({ runtimeDist: value.runtimeDist, env: value.env });
    assert.equal(outputMismatch.bundled, false);
    assert.match(outputMismatch.diagnostic, /output fingerprint/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("missing global Pi preserves JSONL-only server startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-runtime-missing-"));
  try {
    const plan = await resolvePiRuntimeLaunch({
      runtimeDist: join(root, "dist"),
      env: { APPDATA: join(root, "missing-appdata"), PATH: "" },
    });
    assert.equal(plan.piEntry, null);
    assert.equal(plan.bundled, false);
    assert.match(plan.diagnostic, /历史 JSONL/);
    const client = new PiRpcClient({ cwd: root, piEntry: plan.piEntry });
    await assert.rejects(client.start(), /找不到全局 Pi/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit PI_CHAT_PI_ENTRY stays direct and fails closed when missing", async () => {
  const value = await fixture();
  try {
    const direct = await resolvePiRuntimeLaunch({
      runtimeDist: value.runtimeDist,
      env: { ...value.env, PI_CHAT_PI_ENTRY: value.rpcEntry },
    });
    assert.equal(direct.bundled, false);
    assert.equal(direct.piEntry, value.rpcEntry);
    assert.match(direct.diagnostic, /authoritative/);

    const missing = await resolvePiRuntimeLaunch({
      runtimeDist: value.runtimeDist,
      env: { ...value.env, PI_CHAT_PI_ENTRY: join(value.root, "missing.js") },
    });
    assert.equal(missing.piEntry, null);
    assert.equal(missing.bundled, false);
    assert.match(missing.diagnostic, /PI_CHAT_PI_ENTRY/);
    assert.throws(
      () => resolvePiEntry({ ...value.env, PI_CHAT_PI_ENTRY: join(value.root, "missing.js") }),
      /PI_CHAT_PI_ENTRY/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
