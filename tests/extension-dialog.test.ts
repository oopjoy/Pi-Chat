import assert from "node:assert/strict";
import test from "node:test";
import { describeGateRequest } from "../src/web/components/ExtensionDialog";

test("Gate dialog foregrounds the requested file or command instead of Gate provenance", () => {
  assert.deepEqual(describeGateRequest({ type: "extension_ui_request", id: "1", method: "select", title: "📝 Write\n\nWrite to C:\\work\\report.md", options: ["✅ Allow", "❌ Block"] }), {
    action: "Pi 请求写入文件", target: "C:\\work\\report.md",
  });
  assert.deepEqual(describeGateRequest({ type: "extension_ui_request", id: "2", method: "select", title: "⚠️ Destructive bash command:\n\n  rm -rf build\n\nAllow?", options: ["✅ Allow", "❌ Block"] }), {
    action: "Pi 请求执行高风险命令", target: "rm -rf build",
  });
});

test("Gate dialog preserves the dangerous suffix of long commands", () => {
  const command = `echo ${"safe ".repeat(60)}&& rm -rf important-data`;
  const details = describeGateRequest({
    type: "extension_ui_request",
    id: "long-command",
    method: "select",
    title: `⚠️ Destructive bash command:\n\n${command}\n\nAllow?`,
    options: ["✅ Allow", "❌ Block"],
  });
  assert.equal(details.target, command);
  assert.match(details.target, /rm -rf important-data$/);
});
