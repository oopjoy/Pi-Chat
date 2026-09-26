import assert from "node:assert/strict";
import test from "node:test";
import { writeClipboardText } from "../src/web/lib/clipboard";

test("clipboard helper writes through the supplied Clipboard implementation", async () => {
  const writes: string[] = [];
  await writeClipboardText("复制内容", {
    writeText: async (text) => { writes.push(text); },
  });
  assert.deepEqual(writes, ["复制内容"]);
});

test("clipboard helper preserves permission failures", async () => {
  const failure = new Error("permission denied");
  await assert.rejects(
    writeClipboardText("复制内容", {
      writeText: async () => { throw failure; },
    }),
    (error) => error === failure,
  );
});

test("clipboard helper fails clearly when Clipboard API is unavailable", async () => {
  await assert.rejects(
    writeClipboardText("复制内容", undefined),
    /当前环境不支持剪贴板写入/,
  );
});
