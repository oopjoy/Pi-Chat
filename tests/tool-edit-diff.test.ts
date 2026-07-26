import assert from "node:assert/strict";
import test from "node:test";
import { compactEditPath, editDiffFromToolCall } from "../src/web/lib/tool-edit-diff";

test("edit arguments derive independent line-number-free diff hunks", () => {
  const diff = editDiffFromToolCall("edit", {
    path: "src/app.ts",
    edits: [
      { oldText: "const size = 20;", newText: "const size = 10;" },
      { oldText: "old\nline", newText: "new\nline\nextra" },
    ],
  });
  assert.ok(diff);
  assert.equal(diff.path, "src/app.ts");
  assert.equal(diff.deletions, 3);
  assert.equal(diff.additions, 4);
  assert.equal(diff.hunks.length, 2);
  assert.deepEqual(diff.hunks[0].lines, [
    { kind: "delete", text: "const size = 20;" },
    { kind: "add", text: "const size = 10;" },
  ]);
});

test("sensitive edit paths expose only counts", () => {
  const diff = editDiffFromToolCall("edit", {
    path: "config/.env.local",
    edits: [{ oldText: "TOKEN=old", newText: "TOKEN=new" }],
  });
  assert.ok(diff);
  assert.equal(diff.sensitive, true);
  assert.deepEqual(diff.hunks, []);
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
});

test("edit paths keep useful trailing context without exposing a full absolute path", () => {
  assert.equal(compactEditPath("styles.css"), "styles.css");
  assert.equal(compactEditPath("src/web/styles.css"), "src/web/styles.css");
  assert.equal(compactEditPath("C:\\Users\\name\\project\\src\\web\\styles.css"), "…/src/web/styles.css");
});

test("non-edit and malformed calls do not derive a diff", () => {
  assert.equal(editDiffFromToolCall("write", { path: "a", content: "x" }), null);
  assert.equal(editDiffFromToolCall("edit", { path: "a", edits: [] }), null);
});
