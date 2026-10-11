import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";
import { resolve } from "node:path";
import projectConfig from "../eslint.config.js";

const root = resolve(import.meta.dirname, "..");

function createProjectLinter(): ESLint {
  // Pass the repository's flat config directly so lintText cannot lose its
  // config match when the whole Node test batch is running on Windows.
  return new ESLint({ cwd: root, overrideConfigFile: null, ignore: false, overrideConfig: projectConfig });
}

test("converged modules reject floating and misused Promises even with explicit void", async () => {
  const eslint = createProjectLinter();
  const [floating] = await eslint.lintText("async function work() { throw new Error('fixture'); }\nvoid work();\n", { filePath: "src/server/session-projection.ts" });
  assert.ok(
    floating.messages.some(message => message.ruleId === "@typescript-eslint/no-floating-promises" && message.severity === 2),
    JSON.stringify(floating.messages),
  );
  const [misused] = await eslint.lintText("declare function schedule(task: () => void): void;\nschedule(async () => { await Promise.resolve(); });\n", { filePath: "src/server/session-projection.ts" });
  assert.ok(
    misused.messages.some(message => message.ruleId === "@typescript-eslint/no-misused-promises" && message.severity === 2),
    JSON.stringify(misused.messages),
  );
});

test("converged modules accept handled detached work without requiring legacy modules to be clean", async () => {
  const eslint = createProjectLinter();
  const code = "async function work() { throw new Error('fixture'); }\nvoid work().catch(() => {});\n";
  const [handled] = await eslint.lintText(code, { filePath: "src/server/session-projection.ts" });
  assert.equal(handled.errorCount, 0);
  const [legacy] = await eslint.lintText("async function work() {}\nvoid work();\n", { filePath: "src/web/application/session-management-actions.ts" });
  assert.equal(legacy.messages.some(message => message.ruleId === "@typescript-eslint/no-floating-promises"), false);
});
