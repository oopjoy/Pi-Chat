import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAssistantText } from "../src/web/lib/assistant-text";

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
