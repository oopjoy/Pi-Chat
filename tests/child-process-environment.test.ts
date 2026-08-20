import assert from "node:assert/strict";
import test from "node:test";
import { ensureUtf8ChildProcessEnvironment } from "../src/server/child-process-environment.js";

test("Windows Pi child processes receive UTF-8 Python defaults", () => {
  const environment: NodeJS.ProcessEnv = {};
  ensureUtf8ChildProcessEnvironment(environment, "win32");
  assert.equal(environment.PYTHONUTF8, "1");
  assert.equal(environment.PYTHONIOENCODING, "utf-8");
});

test("explicit Python encoding overrides remain authoritative", () => {
  const environment: NodeJS.ProcessEnv = {
    PYTHONUTF8: "0",
    PYTHONIOENCODING: "utf-16",
  };
  ensureUtf8ChildProcessEnvironment(environment, "win32");
  assert.equal(environment.PYTHONUTF8, "0");
  assert.equal(environment.PYTHONIOENCODING, "utf-16");
});

test("non-Windows child environments are unchanged", () => {
  const environment: NodeJS.ProcessEnv = {};
  ensureUtf8ChildProcessEnvironment(environment, "linux");
  assert.deepEqual(environment, {});
});
