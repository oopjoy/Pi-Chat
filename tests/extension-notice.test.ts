import assert from "node:assert/strict";
import test from "node:test";
import { extensionExecutionNotice } from "../src/web/lib/extension-notice";

const commands = [{ name: "gate", source: "extension" as const, description: "Control file permission gate: /gate status|open|strict|once" }];

test("gate extension notices describe the selected permission mode", () => {
  assert.match(extensionExecutionNotice("/gate open", "gate", commands), /不再要求确认/);
  assert.match(extensionExecutionNotice("/gate strict", "gate", commands), /恢复.*确认/);
  assert.match(extensionExecutionNotice("/gate once", "gate", commands), /下一次/);
  assert.match(extensionExecutionNotice("/gate status", "gate", commands), /当前文件权限模式/);
});

test("other extension notices use Pi's dynamic command description", () => {
  const notice = extensionExecutionNotice("/preview-pdf report.md", "preview-pdf", [{ name: "preview-pdf", source: "extension", description: "Export markdown to PDF via pandoc + LaTeX and open it" }]);
  assert.match(notice, /^已执行 \/preview-pdf report\.md · Export markdown to PDF/);
});
