import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ESLint } from "eslint";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const originalCI = process.env.CI;

// Exercise the CI environment even when this regression runs locally.
before(() => { process.env.CI = "true"; });
after(() => {
  if (originalCI === undefined) delete process.env.CI;
  else process.env.CI = originalCI;
});

function createProjectLinter(): ESLint {
  return new ESLint({
    cwd: root,
    overrideConfig: {
      languageOptions: {
        parserOptions: {
          // lintText supplies multiple in-memory versions of existing files.
          // CI single-run inference instead reuses a disk-backed Program on
          // the first parse, so the fixture is not actually checked.
          disallowAutomaticSingleRunInference: true,
        },
      },
    },
  });
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
  assert.deepEqual(handled.messages, []);
  const legacy = await lintText(eslint, "async function work() {}\nvoid work();\n", legacyFixturePath);
  assert.equal(legacy.messages.some(message => message.ruleId === "@typescript-eslint/no-floating-promises"), false);
});
