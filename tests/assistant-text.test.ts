import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAssistantText } from "../src/web/lib/assistant-text";

test("collapses an accidentally repeated complete long assistant response", () => {
  const answer = [
    "## TDGL 求解器说明",
    "",
    "这是一段足够长的完整回答，用于模拟 provider 把终态文本重复拼接到同一个 content block 的情况。",
    "它包含多个段落、参数说明与输出约定；真实回复的正文很长，而不是一个普通的简短复读。",
    "",
    "```bash",
    "python tdgl_linearized_cn.py --profile",
    "```",
    "",
    "请保留三种算法各自独立的输出目录，并在结束后统一写入能量数据。",
  ].join("\n").repeat(8);
  assert.equal(sanitizeAssistantText(`${answer}\n\n${answer}`), answer);
});

test("preserves a long response that merely repeats its opening later", () => {
  const opening = "这是一段正常的长回复开头，用于说明重复开头并不代表整个回答被复制。".repeat(4);
  const source = `${opening}\n\n中间内容不同。${"细节".repeat(220)}\n\n${opening}\n\n结尾内容不同。${"结论".repeat(220)}`;
  assert.equal(sanitizeAssistantText(source), source);
});

test("removes repeated leaked analysis channel markers", () => {
  assert.equal(
    sanitizeAssistantText("before code**/analysis code**/analysis code**/analysis after"),
    "before after",
  );
});

test("removes long multiline runs of leaked analysis channel markers", () => {
  const leaked = Array.from({ length: 36 }, () => "code**/analysis").reduce((lines, marker, index) => {
    const line = Math.floor(index / 6);
    lines[line] = `${lines[line] || ""}${lines[line] ? " " : ""}${marker}`;
    return lines;
  }, [] as string[]).join("\n ");
  assert.equal(sanitizeAssistantText(leaked), "");
  assert.equal(sanitizeAssistantText(`visible before\n${leaked}\nvisible after`), "visible before\nvisible after");
});

test("removes a leaked thinking prefix with repeated channel markers", () => {
  assert.equal(
    sanitizeAssistantText("<thinking>private**/analysis code**/analysis code**/analysis code**/analysis visible"),
    "visible",
  );
});

test("removes repeated private thinking-title dumps, including a clipped final title", () => {
  const leaked = [
    "**Planning send flow and model lock redesign**",
    "",
    "**Analyzing composer controls disabled state**",
    "",
    "**Designing send intent and local queue handling**",
    "",
    "**Analyzing composer controls disabled state**",
    "",
    "**Analyzing ChatInput disabled state",
  ].join("\n");
  assert.equal(sanitizeAssistantText(`visible before\n${leaked}\nvisible after`), "visible before\nvisible after");
});

test("removes a leaked private process restatement", () => {
  const leaked = "The user wants me to review the completed Composer work and compare it with DeepSeek harness. Let me thoroughly review the implementation first.";
  assert.equal(sanitizeAssistantText(leaked), "");
});

test("preserves a non-process sentence with the same opening words", () => {
  const ordinary = "The user wants me to choose a blue theme.";
  assert.equal(sanitizeAssistantText(ordinary), ordinary);
});

test("preserves a short ordinary Markdown outline", () => {
  const outline = [
    "**Planning the release**",
    "",
    "**Reviewing tests**",
    "",
    "**Testing the fix**",
  ].join("\n");
  assert.equal(sanitizeAssistantText(outline), outline);
});

test("preserves ordinary single references to the analysis marker", () => {
  const source = "The literal code**/analysis marker appeared once.";
  assert.equal(sanitizeAssistantText(source), source);
});

test("preserves Markdown whitespace outside the leaked run", () => {
  assert.equal(
    sanitizeAssistantText("    indented code\ncode**/analysis code**/analysis code**/analysis\nnext  \n"),
    "    indented code\nnext  \n",
  );
  assert.equal(
    sanitizeAssistantText("- item\n  nested code**/analysis code**/analysis code**/analysis tail\n"),
    "- item\n  nested tail\n",
  );
  assert.equal(
    sanitizeAssistantText("```text\nvalue\n```\ncode**/analysis code**/analysis code**/analysis"),
    "```text\nvalue\n```\n",
  );
});
