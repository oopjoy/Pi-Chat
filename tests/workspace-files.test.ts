import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listWorkspaceDirectory, readWorkspaceFile } from "../src/server/workspace-files";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-files-"));
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await mkdir(join(root, "build"), { recursive: true });
  await mkdir(join(root, "vendor"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Demo\n");
  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
  await writeFile(join(root, "src", "nested", "note.txt"), "nested\n");
  await writeFile(join(root, ".env"), "TOKEN=secret\n");
  await writeFile(join(root, "client-secret.json"), "secret\n");
  await writeFile(join(root, "auth.json"), "secret\n");
  await writeFile(join(root, "token.json"), "secret\n");
  await writeFile(join(root, "password.txt"), "secret\n");
  await writeFile(join(root, "service-account.json"), "secret\n");
  await writeFile(join(root, "github-token.txt"), "secret\n");
  await writeFile(join(root, "api-key.txt"), "secret\n");
  await writeFile(join(root, "private-key.txt"), "secret\n");
  await writeFile(join(root, "node_modules", "package.js"), "ignored\n");
  await writeFile(join(root, "build", "bundle.js"), "ignored\n");
  await writeFile(join(root, "vendor", "library.js"), "ignored\n");
  return root;
}

test("workspace files list one safe level and read bounded text previews", async () => {
  const root = await fixture();
  try {
    const top = await listWorkspaceDirectory(root);
    assert.deepEqual(top.entries, [
      { name: "src", type: "directory" },
      { name: "README.md", type: "file" },
    ]);
    assert.equal(top.truncated, false);

    const src = await listWorkspaceDirectory(root, "src");
    assert.deepEqual(src.entries, [
      { name: "nested", type: "directory" },
      { name: "app.ts", type: "file" },
    ]);

    const preview = await readWorkspaceFile(root, "src/app.ts");
    assert.deepEqual(preview, {
      path: "src/app.ts",
      name: "app.ts",
      size: 24,
      text: "export const value = 1;\n",
      truncated: false,
      encodingLossy: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file reads reject traversal, hidden secrets, and binary content", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "binary.bin"), Buffer.from([1, 0, 2]));
    await assert.rejects(() => listWorkspaceDirectory(root, "../outside"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, ".env"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "client-secret.json"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "auth.json"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "token.json"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "password.txt"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "github-token.txt"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "api-key.txt"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "private-key.txt"), /路径无效/);
    await assert.rejects(() => listWorkspaceDirectory(root, "build"), /路径无效/);
    await assert.rejects(() => listWorkspaceDirectory(root, "vendor"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "README.md:data"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "binary.bin"), /二进制文件/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file reads reject symlinked paths even when their target stays inside the workspace", async (context) => {
  const root = await fixture();
  try {
    try {
      await symlink(join(root, "src"), join(root, "linked-src"), "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        context.skip(`directory symlink creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(() => listWorkspaceDirectory(root, "linked-src"), /符号链接/);
    await assert.rejects(() => readWorkspaceFile(root, "linked-src/app.ts"), /符号链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file previews reject malformed UTF-8 and trim a split boundary safely", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
    await assert.rejects(() => readWorkspaceFile(root, "invalid.txt"), /UTF-8/);
    const prefix = Buffer.from("a".repeat(256 * 1024 - 1));
    const multibyte = Buffer.from("你tail", "utf8");
    await writeFile(join(root, "boundary.txt"), Buffer.concat([prefix, multibyte]));
    const preview = await readWorkspaceFile(root, "boundary.txt");
    assert.equal(preview.text, "a".repeat(256 * 1024 - 1));
    assert.equal(preview.encodingLossy, false);
    assert.equal(preview.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace text previews truncate large files without reading the whole file", async () => {
  const root = await fixture();
  try {
    const content = "a".repeat(300 * 1024);
    await writeFile(join(root, "large.txt"), content);
    const preview = await readWorkspaceFile(root, "large.txt");
    assert.equal(preview.text.length, 256 * 1024);
    assert.equal(preview.size, content.length);
    assert.equal(preview.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
