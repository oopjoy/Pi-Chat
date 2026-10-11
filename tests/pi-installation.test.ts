import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolvePiEntry, resolvePiVersion } from "../src/server/rpc-client";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pi-chat-installation-"));
  const env: NodeJS.ProcessEnv = { USERPROFILE: home, HOME: home, PATH: "" };
  const managed = join(home, ".pi", "agent", "install");
  const makePackage = async (prefix: string, version = "1.1.0") => {
    const root = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
    const entry = join(root, "dist", "rpc-entry.js");
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "throw new Error('Discovery must not execute this entry');\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
    return realpath(entry);
  };
  const setManaged = async (root = managed, version = "1.1.0") => {
    const entry = await makePackage(join(root, "releases", version), version);
    await writeFile(join(root, "current-version"), `${version}\r\n`);
    return entry;
  };
  return { home, env, managed, makePackage, setManaged, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("Pi discovery finds managed installations and follows the current version on the next resolution", async () => {
  const f = await fixture();
  try {
    const first = await f.setManaged();
    assert.equal(resolvePiEntry(f.env), first);
    assert.equal(resolvePiVersion(first), "1.1.0");
    const second = await f.setManaged(f.managed, "1.2.0-beta.1");
    assert.equal(resolvePiEntry(f.env), second);
    assert.equal(resolvePiVersion(second), "1.2.0-beta.1");
  } finally { await f.cleanup(); }
});

test("Pi discovery honors explicit entries and never falls back from an invalid explicit entry", async () => {
  const f = await fixture();
  try {
    await f.setManaged();
    const explicit = await f.makePackage(join(f.home, "explicit install"));
    assert.equal(resolvePiEntry({ ...f.env, PI_CHAT_PI_ENTRY: explicit }), explicit);
    assert.throws(() => resolvePiEntry({ ...f.env, PI_CHAT_PI_ENTRY: join(f.home, "missing.js") }), /PI_CHAT_PI_ENTRY/);
    assert.throws(() => resolvePiEntry({ ...f.env, PI_CHAT_PI_ENTRY: f.home }), /PI_CHAT_PI_ENTRY/);
  } finally { await f.cleanup(); }
});

test("Pi discovery supports a custom managed root with spaces and shell metacharacters", async () => {
  const f = await fixture();
  try {
    const root = join(f.home, "Pi's & (managed) 中文");
    const entry = await f.setManaged(root);
    await f.setManaged();
    assert.equal(resolvePiEntry({ ...f.env, PI_MANAGED_INSTALL_ROOT: root }), entry);
  } finally { await f.cleanup(); }
});

test("Pi discovery rejects malformed managed pointers and falls back to npm without executing shims", async () => {
  const f = await fixture();
  try {
    await f.setManaged();
    const prefix = join(f.home, "npm prefix");
    const entry = await f.makePackage(prefix);
    for (const pointer of ["", ".", "..", "../escape", "..\\escape", "x & echo bad", "x\ny", "a".repeat(257), "missing-release"]) {
      await writeFile(join(f.managed, "current-version"), pointer);
      assert.equal(resolvePiEntry({ ...f.env, npm_config_prefix: prefix }), entry, pointer);
    }
    assert.equal(resolvePiEntry({ ...f.env, APPDATA: f.home, PATH: `"${prefix}"` }), entry);
    if (process.platform === "win32") assert.equal(resolvePiEntry({ ...f.env, PATH: undefined, Path: prefix }), entry);
  } finally { await f.cleanup(); }
});

test("Pi discovery preserves AppData npm and Unix npm-prefix layouts", async () => {
  const f = await fixture();
  try {
    const appdataEntry = await f.makePackage(join(f.home, "npm"));
    assert.equal(resolvePiEntry({ ...f.env, APPDATA: f.home }), appdataEntry);
    const prefix = join(f.home, "unix-prefix");
    const libEntry = await f.makePackage(join(prefix, "lib"));
    assert.equal(resolvePiEntry({ ...f.env, NPM_CONFIG_PREFIX: prefix }), libEntry);
  } finally { await f.cleanup(); }
});

test("Pi version lookup walks through dist but does not import Pi or accept malformed metadata", async () => {
  const f = await fixture();
  try {
    const entry = await f.makePackage(f.home);
    assert.equal(resolvePiVersion(entry), "1.1.0");
    await writeFile(join(dirname(dirname(entry)), "package.json"), "{ invalid json");
    assert.equal(resolvePiVersion(entry), undefined);
    assert.equal(resolvePiVersion(null), undefined);
    assert.equal(resolvePiVersion(join(f.home, "missing.js")), undefined);
  } finally { await f.cleanup(); }
});
