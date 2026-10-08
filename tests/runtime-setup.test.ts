import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RuntimeSetupStore, parseRuntimeSetupChange, validateRuntimeEntry } from "../src/server/runtime-setup";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-runtime-setup-"));
  const agent = join(root, "agent");
  const env = { HOME: root, USERPROFILE: root, PATH: "" };
  const store = new RuntimeSetupStore(root, agent, env);
  const makeEntry = async (prefix: string, version = "1.1.0") => {
    const pkg = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
    const entry = join(pkg, "dist", "rpc-entry.js");
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "throw new Error('Must not execute during detection');\n");
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, type: "module" }));
    return realpath(entry);
  };
  return { root, agent, env, store, makeEntry, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("runtime selection validates package identity without executing code or persisting a preview", async () => {
  const f = await fixture();
  try {
    const entry = await f.makeEntry(join(f.root, "Pi's & (local) 中文"));
    assert.deepEqual(validateRuntimeEntry(entry), { entry, version: "1.1.0" });
    assert.equal(existsSync(f.store.path), false);
    assert.throws(() => validateRuntimeEntry("relative/dist/rpc-entry.js"), /可信 Pi/);
    assert.throws(() => validateRuntimeEntry(dirname(entry)), /可信 Pi/);
    await writeFile(join(dirname(dirname(entry)), "package.json"), JSON.stringify({ name: "other", version: "1" }));
    assert.throws(() => validateRuntimeEntry(entry), /可信 Pi/);
  } finally { await f.cleanup(); }
});

test("runtime preference persists only on commit and is isolated by checkout", async () => {
  const f = await fixture();
  try {
    const entry = await f.makeEntry(f.root);
    const before = f.store.status(null);
    const prepared = f.store.prepare({ mode: "select", entry, configurationRevision: before.configurationRevision });
    assert.equal(existsSync(f.store.path), false);
    await prepared.commit();
    const next = new RuntimeSetupStore(f.root, f.agent, f.env);
    assert.deepEqual(next.resolveLaunch(), { candidate: { entry, version: "1.1.0" }, source: "saved" });
    assert.notEqual(next.status(null).configurationRevision, before.configurationRevision);
    assert.notEqual(new RuntimeSetupStore(join(f.root, "another-checkout"), f.agent, f.env).path, next.path);
    assert.equal(next.status(null).current, null, "saved configuration must not pretend the running plan changed");
  } finally { await f.cleanup(); }
});

test("runtime preference revalidates the revision and candidate at commit", async () => {
  const f = await fixture();
  try {
    const entry = await f.makeEntry(f.root);
    const change = { mode: "select" as const, entry, configurationRevision: f.store.status(null).configurationRevision };
    const first = f.store.prepare(change);
    const stale = f.store.prepare(change);
    await first.commit();
    const saved = await readFile(f.store.path, "utf8");
    await assert.rejects(stale.commit(), /设置已变化/);
    assert.equal(await readFile(f.store.path, "utf8"), saved);
    const pending = f.store.prepare({ ...change, configurationRevision: f.store.status(null).configurationRevision });
    await rm(entry);
    await assert.rejects(pending.commit(), /可信 Pi/);
    assert.equal(await readFile(f.store.path, "utf8"), saved);
  } finally { await f.cleanup(); }
});

test("environment entry remains authoritative and invalid overrides never silently fall back", async () => {
  const f = await fixture();
  try {
    const entry = await f.makeEntry(f.root);
    const store = new RuntimeSetupStore(f.root, f.agent, { ...f.env, PI_CHAT_PI_ENTRY: entry });
    const status = store.status(null);
    assert.equal(status.source, "environment");
    assert.equal(status.environmentOverride, true);
    assert.throws(() => store.prepare({ mode: "select", entry, configurationRevision: status.configurationRevision }), /环境变量优先/);
    await store.prepare({ mode: "retry", configurationRevision: status.configurationRevision }).commit();
    assert.equal(existsSync(store.path), false);
    const invalid = new RuntimeSetupStore(f.root, f.agent, { ...f.env, PI_CHAT_PI_ENTRY: join(f.root, "missing.js") });
    assert.equal(invalid.status(null).configured, null);
    assert.match(invalid.status(null).error || "", /PI_CHAT_PI_ENTRY/);
    assert.throws(() => invalid.prepare({ mode: "retry", configurationRevision: invalid.status(null).configurationRevision }), /PI_CHAT_PI_ENTRY/);
  } finally { await f.cleanup(); }
});

test("automatic detection can explicitly repair malformed saved configuration but rejects a changed install", async () => {
  const f = await fixture();
  try {
    const managed = join(f.root, ".pi", "agent", "install");
    const entry = await f.makeEntry(join(managed, "releases", "1.1.0"));
    await writeFile(join(managed, "current-version"), "1.1.0\n");
    await mkdir(dirname(f.store.path), { recursive: true });
    await writeFile(f.store.path, "malformed");
    const before = f.store.status(null);
    assert.match(before.error || "", /已保存/);
    assert.equal(before.automatic?.entry, entry);
    const prepare = f.store.prepare({ mode: "automatic", configurationRevision: before.configurationRevision });
    await f.makeEntry(join(managed, "releases", "1.2.0"), "1.2.0");
    await writeFile(join(managed, "current-version"), "1.2.0\n");
    await assert.rejects(prepare.commit(), /安装在检测后发生变化/);
    assert.equal(await readFile(f.store.path, "utf8"), "malformed");
    await f.store.prepare({ mode: "automatic", configurationRevision: before.configurationRevision }).commit();
    assert.equal(f.store.status(null).source, "automatic");
    assert.equal(f.store.resolveLaunch().candidate?.version, "1.2.0");
  } finally { await f.cleanup(); }
});

test("runtime setup rejects ambiguous and oversized mutation shapes", () => {
  const revision = "a".repeat(64);
  assert.deepEqual(parseRuntimeSetupChange({ mode: "retry", configurationRevision: revision }), { mode: "retry", configurationRevision: revision });
  for (const body of [{}, { mode: ["retry"], configurationRevision: revision }, { mode: "retry", configurationRevision: revision, entry: "extra" }, { mode: "select", configurationRevision: revision, entry: "a".repeat(4097) }, { mode: "automatic", configurationRevision: revision, secret: "unknown" }])
    assert.throws(() => parseRuntimeSetupChange(body), /设置请求无效/);
});
