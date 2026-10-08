import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("converged modules reject floating and misused Promises even with explicit void", async () => {
  const eslint = new ESLint({ cwd: root });
  const [floating] = await eslint.lintText("async function work() { throw new Error('fixture'); }\nvoid work();\n", { filePath: resolve(root, "src/server/session-projection.ts") });
  assert.ok(floating.messages.some(message => message.ruleId === "@typescript-eslint/no-floating-promises" && message.severity === 2));
  const [misused] = await eslint.lintText("declare function schedule(task: () => void): void;\nschedule(async () => { await Promise.resolve(); });\n", { filePath: resolve(root, "src/server/session-projection.ts") });
  assert.ok(misused.messages.some(message => message.ruleId === "@typescript-eslint/no-misused-promises" && message.severity === 2));
});

test("converged modules accept handled detached work without requiring legacy modules to be clean", async () => {
  const eslint = new ESLint({ cwd: root });
  const code = "async function work() { throw new Error('fixture'); }\nvoid work().catch(() => {});\n";
  const [handled] = await eslint.lintText(code, { filePath: resolve(root, "src/server/session-projection.ts") });
  assert.equal(handled.errorCount, 0);
  const [legacy] = await eslint.lintText("async function work() {}\nvoid work();\n", { filePath: resolve(root, "src/web/application/session-management-actions.ts") });
  assert.equal(legacy.messages.some(message => message.ruleId === "@typescript-eslint/no-floating-promises"), false);
});
