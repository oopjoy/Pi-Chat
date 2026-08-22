import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiMessage } from "../src/shared/types";
import { readWorkspaceFile, recentModifiedWorkspaceFiles } from "../src/server/workspace-files";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-files-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "build"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Demo\n\nWorkspace preview.\n");
  await writeFile(join(root, "src", "app.ts"), "export const app = true;\n");
  await writeFile(join(root, "docs", "new.md"), "new document\n");
  await writeFile(join(root, "github-token.txt"), "secret\n");
  await writeFile(join(root, "build", "bundle.js"), "ignored\n");
  return root;
}

function call(id: string, name: string, path: string): PiMessage {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { path } }] };
}

function result(id: string, name: string, timestamp: number, isError = false): PiMessage {
  return { role: "toolResult", toolCallId: id, toolName: name, timestamp, isError, content: isError ? "failed" : "ok" };
}

test("recent files project only successful Edit and Write results, newest first and deduplicated", async () => {
  const root = await fixture();
  try {
    const messages: PiMessage[] = [
      call("edit-old", "edit", join(root, "src", "app.ts")),
      result("edit-old", "edit", 10),
      call("write-doc", "write", "docs\\new.md"),
      result("write-doc", "write", 20),
      call("read-only", "read", "README.md"),
      result("read-only", "read", 30),
      call("failed-edit", "edit", "README.md"),
      result("failed-edit", "edit", 40, true),
      call("secret-edit", "edit", "github-token.txt"),
      result("secret-edit", "edit", 45),
      call("outside-edit", "edit", join(root, "..", "outside.txt")),
      result("outside-edit", "edit", 46),
      call("edit-new", "edit", "src/app.ts"),
      result("edit-new", "edit", 50),
    ];
    assert.deepEqual(recentModifiedWorkspaceFiles(messages, root), {
      files: [
        { path: "src/app.ts", name: "app.ts", operation: "edit", modifiedAt: 50 },
        { path: "docs/new.md", name: "new.md", operation: "write", modifiedAt: 20 },
      ],
      truncated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent file projection is bounded to fifty unique paths", () => {
  const messages: PiMessage[] = [];
  for (let index = 0; index < 51; index += 1) {
    messages.push(call(`edit-${index}`, "edit", `src/file-${index}.ts`));
    messages.push(result(`edit-${index}`, "edit", index));
  }
  const recent = recentModifiedWorkspaceFiles(messages, "C:/work");
  assert.equal(recent.files.length, 50);
  assert.equal(recent.files[0]?.path, "src/file-50.ts");
  assert.equal(recent.truncated, true);
});

test("workspace file reads remain bounded and reject traversal, secrets, generated paths, and binary content", async () => {
  const root = await fixture();
  try {
    const preview = await readWorkspaceFile(root, "src/app.ts");
    assert.equal(preview.path, "src/app.ts");
    assert.match(preview.text, /export const app/);
    await assert.rejects(() => readWorkspaceFile(root, "../README.md"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, ".env"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "github-token.txt"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "build/bundle.js"), /路径无效/);
    await assert.rejects(() => readWorkspaceFile(root, "README.md:data"), /路径无效/);
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
    await assert.rejects(() => readWorkspaceFile(root, "binary.bin"), /二进制/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file reads reject symlinked paths even when their target stays inside the workspace", async (context) => {
  const root = await fixture();
  try {
    try {
      await symlink(join(root, "README.md"), join(root, "readme-link.md"), "file");
      await symlink(join(root, "src"), join(root, "src-link"), "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        context.skip(`symlink creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(() => readWorkspaceFile(root, "readme-link.md"), /符号链接/);
    await assert.rejects(() => readWorkspaceFile(root, "src-link/app.ts"), /符号链接/);
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
    await writeFile(join(root, "boundary.txt"), Buffer.concat([prefix, Buffer.from("你tail", "utf8")]));
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
    await writeFile(join(root, "large.txt"), "x".repeat(300 * 1024));
    const preview = await readWorkspaceFile(root, "large.txt");
    assert.equal(preview.text.length, 256 * 1024);
    assert.equal(preview.size, 300 * 1024);
    assert.equal(preview.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
