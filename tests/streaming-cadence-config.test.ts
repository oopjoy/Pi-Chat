import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isIsolatedStreamingBenchmarkRuntime,
  parseBenchmarkSseSnapshotInterval,
} from "../src/server/benchmark-streaming-config";
import {
  assertBrowserStreamingBenchmarkStaging,
  parseBrowserStreamingBenchmarkPolicy as parseBuildPolicy,
} from "../scripts/streaming-cadence-config.mjs";
import { parseBrowserStreamingBenchmarkPolicy } from "../src/web/lib/live-message-policy";

test("production streaming cadence defaults remain unchanged", () => {
  assert.equal(parseBenchmarkSseSnapshotInterval(undefined), undefined);
  assert.equal(parseBuildPolicy(undefined), "timeout-50");
  assert.equal(parseBuildPolicy(""), "timeout-50");
  assert.equal(parseBrowserStreamingBenchmarkPolicy(undefined), 50);
  assert.equal(parseBrowserStreamingBenchmarkPolicy("timeout-50"), 50);
});

test("benchmark server cadence requires validated temporary isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-streaming-cadence-"));
  const runtimeDist = join(root, "stage");
  const configPath = join(root, "stream-config.json");
  const liveDist = join(root, "live-dist");
  try {
    await mkdir(runtimeDist);
    await mkdir(liveDist);
    await writeFile(configPath, "{}\n", "utf8");
    assert.equal(isIsolatedStreamingBenchmarkRuntime({
      configPath,
      declaredRuntimeDist: runtimeDist,
      runtimeDist,
      liveDist,
      port: 31001,
    }), true);
    assert.equal(isIsolatedStreamingBenchmarkRuntime({
      configPath,
      declaredRuntimeDist: runtimeDist,
      runtimeDist,
      liveDist,
      port: 30170,
    }), false);
    assert.equal(isIsolatedStreamingBenchmarkRuntime({
      configPath: join(root, "missing.json"),
      declaredRuntimeDist: runtimeDist,
      runtimeDist,
      liveDist,
      port: 31001,
    }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark streaming cadence accepts only the measured policies", () => {
  assert.equal(parseBenchmarkSseSnapshotInterval("25", true), 25);
  assert.equal(parseBenchmarkSseSnapshotInterval("33", true), 33);
  assert.equal(parseBenchmarkSseSnapshotInterval("50", true), 50);
  assert.deepEqual(
    parseBrowserStreamingBenchmarkPolicy("animation-frame"),
    { mode: "animation-frame" },
  );
  assert.equal(parseBuildPolicy("animation-frame"), "animation-frame");
  assert.doesNotThrow(() => assertBrowserStreamingBenchmarkStaging(
    "animation-frame",
    "C:/Temp/stage",
    "C:/repo/dist",
    "win32",
  ));
});

test("invalid benchmark cadence configuration fails closed", () => {
  assert.throws(() => parseBenchmarkSseSnapshotInterval("50"));
  for (const value of ["", "0", "16", "34", "50 ", "unknown"]) {
    assert.throws(() => parseBenchmarkSseSnapshotInterval(value, true));
  }
  assert.throws(() => parseBuildPolicy("raf"));
  assert.throws(() => assertBrowserStreamingBenchmarkStaging(
    "animation-frame",
    "C:/REPO/DIST",
    "c:/repo/dist",
    "win32",
  ));
  assert.throws(() => parseBrowserStreamingBenchmarkPolicy("raf"));
});
