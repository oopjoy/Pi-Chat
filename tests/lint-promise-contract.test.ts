import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";
import { resolve } from "node:path";
import projectConfig from "../eslint.config.js";

const root = resolve(import.meta.dirname, "..");

function createProjectLinter(): ESLint {
  // Pass the repository's flat config directly so the contract does not
  // depend on ESLint discovering a config during a Windows test batch.
  return new ESLint({ cwd: root, overrideConfigFile: null, ignore: false, overrideConfig: projectConfig });
}

const serverFixturePath = resolve(root, "src/server/session-projection.ts");
const legacyFixturePath = resolve(root, "src/web/application/session-management-actions.ts");

async function lintText(eslint: ESLint, source: string, filePath: string) {
  return (await eslint.lintText(source, { filePath, warnIgnored: true }))[0]!;
}

test("converged modules reject floating and misused Promises even with explicit void", async () => {
  const eslint = createProjectLinter();
  const floating = await lintText(eslint, "async function work() { throw new Error('fixture'); }\nvoid work();\n", serverFixturePath);
  assert.ok(
    floating.messages.some(message => message.ruleId === "@typescript-eslint/no-floating-promises" && message.severity === 2),
    JSON.stringify(floating.messages),
  );
  const misused = await lintText(eslint, "declare function schedule(task: () => void): void;\nschedule(async () => { await Promise.resolve(); });\n", serverFixturePath);
  assert.ok(
    misused.messages.some(message => message.ruleId === "@typescript-eslint/no-misused-promises" && message.severity === 2),
    JSON.stringify(misused.messages),
  );
});

test("converged modules accept handled detached work without requiring legacy modules to be clean", async () => {
  const eslint = createProjectLinter();
  const handled = await lintText(eslint, "async function work() { throw new Error('fixture'); }\nvoid work().catch(() => {});\n", serverFixturePath);
  assert.equal(handled.errorCount, 0);
  const legacy = await lintText(eslint, "async function work() {}\nvoid work();\n", legacyFixturePath);
  assert.equal(legacy.messages.some(message => message.ruleId === "@typescript-eslint/no-floating-promises"), false);
});
