import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  UnsafeDistTargetError,
  validateDistTarget,
} from "../scripts/dist-paths.mjs";

const root = resolve(import.meta.dirname, "..");
const guard = resolve(root, "scripts", "assert-safe-live-dist.mjs");

async function runGuard(port: number, distDir?: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [guard], {
    cwd: root,
    env: { ...process.env, PI_CHAT_PORT: String(port), PI_CHAT_DIST_DIR: distDir || "" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const [code] = await once(child, "exit") as [number | null];
  return { code, stderr };
}

test("direct builds refuse to replace dist served by a live Pi Chat listener", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      service: "pi-chat",
      buildIdentity: { fingerprint: "a".repeat(64) },
    }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runGuard(address.port);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /拒绝直接覆盖正在运行的 Pi Chat dist/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("a Windows case variant of live dist still checks the active listener", { skip: process.platform !== "win32" }, async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      service: "pi-chat",
      buildIdentity: { fingerprint: "a".repeat(64) },
    }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runGuard(address.port, resolve(root, "DIST"));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /拒绝直接覆盖正在运行的 Pi Chat dist/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("staged builds never inspect or block the live Pi Chat listener", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, service: "pi-chat", buildIdentity: { fingerprint: "a".repeat(64) } }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const staged = resolve(root, ".pi-chat-build-guard-test-staged");
  try {
    const result = await runGuard(address.port, staged);
    assert.equal(result.code, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("build output validation accepts only controlled repository or OS-temp roots", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-chat-dist-roots-"));
  const projectRoot = join(temporaryRoot, "project");
  const foreignWorktree = join(temporaryRoot, "foreign-worktree");
  const nestedForeignWorktree = join(projectRoot, "foreign-worktree");
  try {
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await mkdir(foreignWorktree, { recursive: true });
    await writeFile(join(foreignWorktree, ".git"), "gitdir: elsewhere\n");
    await mkdir(join(nestedForeignWorktree, "output"), { recursive: true });
    await writeFile(join(nestedForeignWorktree, ".git"), "gitdir: elsewhere\n");

    assert.equal(
      validateDistTarget({ projectRoot, requested: "dist", temporaryRoot }).kind,
      "live",
    );
    assert.equal(
      validateDistTarget({
        projectRoot,
        requested: ".pi-chat-unit-stage",
        temporaryRoot,
      }).kind,
      "repository-stage",
    );
    assert.equal(
      validateDistTarget({
        projectRoot,
        requested: join(temporaryRoot, "owned-stage"),
        temporaryRoot,
      }).kind,
      "temporary-stage",
    );
    assert.throws(
      () => validateDistTarget({ projectRoot, requested: projectRoot, temporaryRoot }),
      UnsafeDistTargetError,
    );
    assert.throws(
      () => validateDistTarget({ projectRoot, requested: "src", temporaryRoot }),
      UnsafeDistTargetError,
    );
    assert.throws(
      () => validateDistTarget({
        projectRoot,
        requested: foreignWorktree,
        temporaryRoot,
      }),
      /another Git worktree/,
    );

    const linkedStage = join(projectRoot, ".pi-chat-linked-stage");
    await symlink(
      join(nestedForeignWorktree, "output"),
      linkedStage,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => validateDistTarget({
        projectRoot,
        requested: linkedStage,
        temporaryRoot,
      }),
      /another Git worktree/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the build guard rejects an unsafe output path before checking a listener", async () => {
  const result = await runGuard(65_534, resolve(root, "src"));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /构建路径检查失败/);
});
