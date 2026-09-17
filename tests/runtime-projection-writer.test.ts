import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  ApplicationLifecycle,
  PrimaryRuntimeReadiness,
} from "../src/shared/types";
import type { PrimaryCapabilitySnapshot } from "../src/web/application/runtime-readiness";
import { RuntimeProjectionWriter } from "../src/web/application/runtime-projection-writer";

function readiness(
  patch: Partial<PrimaryRuntimeReadiness> = {},
): PrimaryRuntimeReadiness {
  return { status: "starting", generation: 1, ...patch };
}

function fixture() {
  let runEpochGeneration = 0;
  let currentReadiness = readiness({ generation: 0 });
  let currentCapability: PrimaryCapabilitySnapshot | null = null;
  let currentLifecycle: ApplicationLifecycle = "idle";
  const writer = new RuntimeProjectionWriter(
    {
      readiness: (next) => { currentReadiness = next; },
      capability: (next) => { currentCapability = next; },
      lifecycle: (next) => { currentLifecycle = next; },
    },
    () => runEpochGeneration,
  );
  return {
    writer,
    values: () => ({
      readiness: currentReadiness,
      capability: currentCapability,
      lifecycle: currentLifecycle,
    }),
    replaceProcess: () => { runEpochGeneration += 1; },
  };
}

test("App routes core Runtime lifecycle writes through the projection writer", async () => {
  const source = await readFile(
    new URL("../src/web/App.tsx", import.meta.url),
    "utf8",
  );
  for (const directWrite of [
    "setPrimaryRuntime(",
    "setPrimaryCapabilitySnapshot(",
    "setApplicationLifecycle(",
    "publishPrimaryReadiness(",
    "publishPrimaryCapabilitySnapshot(",
    "publishApplicationLifecycle(",
  ]) assert.equal(source.includes(directWrite), false, directWrite);
  assert.match(
    source,
    /data\.applicationLifecycle === undefined\s*\? "idle"\s*:\s*data\.applicationLifecycle/,
    "legacy bootstrap may default an absent lifecycle but must not coerce malformed values",
  );
  assert.equal(
    source.includes("applyBootstrapMetadata(data, runtimeProjectionAuthority)"),
    false,
    "mutation responses must not impersonate ordered Runtime refreshes",
  );
});

test("current bootstrap Runtime projection commits atomically", () => {
  const { writer, values } = fixture();
  const authority = writer.captureAuthority(0);
  assert.equal(writer.commitBootstrap({
    readiness: readiness({ status: "ready", generation: 2 }),
    lifecycle: "models-refreshing",
  }, authority), true);
  assert.deepEqual(values(), {
    readiness: readiness({ status: "ready", generation: 2 }),
    capability: null,
    lifecycle: "models-refreshing",
  });
});

test("resource reload rejects every pre-reload async Runtime projection", () => {
  const { writer, values } = fixture();
  const authority = writer.captureAuthority(0);
  writer.observeTransportReady(readiness({ status: "ready", generation: 4 }));
  assert.equal(writer.publishReadyCapability({
    generation: 4,
    modelKeys: ["test/model"],
  }), true);

  writer.observeLifecycle("resources-reloading");
  writer.resetForResourceReload();
  assert.deepEqual(values(), {
    readiness: readiness({ generation: 4 }),
    capability: null,
    lifecycle: "resources-reloading",
  });
  assert.equal(writer.commitBootstrap({
    readiness: readiness({ status: "failed", generation: 5 }),
    lifecycle: "idle",
  }, authority), false);
  assert.equal(writer.confirmBootstrapCapability({
    readiness: readiness({ status: "ready", generation: 4 }),
    committedModelKey: "test/model",
    modelKeys: ["test/model"],
  }, authority), false);
  assert.deepEqual(values(), {
    readiness: readiness({ generation: 4 }),
    capability: null,
    lifecycle: "resources-reloading",
  });
});

test("process replacement accepts its lower local readiness generation", () => {
  const { writer, values, replaceProcess } = fixture();
  writer.observeTransportReady(readiness({ status: "ready", generation: 9 }));
  writer.publishReadyCapability({
    generation: 9,
    modelKeys: ["test/model"],
  });
  const oldAuthority = writer.captureAuthority(0);
  replaceProcess();
  writer.resetForProcessReplacement();
  assert.deepEqual(values().readiness, readiness({ generation: 0 }));
  assert.equal(values().capability, null);
  assert.equal(writer.commitBootstrap({
    readiness: readiness({ status: "failed", generation: 10 }),
    lifecycle: "idle",
  }, oldAuthority), false);
  const replacementAuthority = writer.captureAuthority(1);
  assert.equal(writer.commitBootstrap({
    readiness: readiness({ status: "ready", generation: 1 }),
    lifecycle: "idle",
  }, replacementAuthority), true);
  assert.deepEqual(values().readiness, readiness({
    status: "ready",
    generation: 1,
  }));
});

test("Runtime status preserves monotonic readiness and clears stale capability", () => {
  const { writer, values } = fixture();
  writer.observeTransportReady(readiness({ status: "ready", generation: 3 }));
  writer.publishReadyCapability({
    generation: 3,
    modelKeys: ["test/model"],
  });
  const stale = writer.observeRuntimeStatus(
    readiness({ status: "failed", generation: 2, error: "old" }),
  );
  assert.equal(stale.committed, false);
  assert.equal(values().capability?.generation, 3);

  const refined = writer.observeRuntimeStatus(readiness({
    status: "ready",
    generation: 3,
    incidentId: "PC-REFINE01",
    model: { id: "model", name: "Model", provider: "test" },
    sessionId: "0123456789abcdefabcd",
    thinkingLevel: "high",
  }));
  assert.equal(refined.committed, true);
  assert.equal(values().readiness.incidentId, "PC-REFINE01");
  assert.equal(values().readiness.model?.id, "model");
  assert.equal(values().readiness.sessionId, "0123456789abcdefabcd");
  assert.equal(values().readiness.thinkingLevel, "high");

  const failed = writer.observeRuntimeStatus(
    readiness({ status: "failed", generation: 4, error: "current" }),
  );
  assert.equal(failed.committed, true);
  assert.equal(values().readiness.error, "current");
  assert.equal(values().capability, null);
});

test("synchronous Runtime observations retire older async authority but duplicates do not", () => {
  const { writer } = fixture();
  const beforeReadiness = writer.captureAuthority(0);
  const ready = readiness({ status: "ready", generation: 2 });
  assert.equal(writer.observeRuntimeStatus(ready).committed, true);
  assert.equal(writer.isCurrent(beforeReadiness), false);

  const afterReadiness = writer.captureAuthority(0);
  assert.equal(writer.observeRuntimeStatus(ready).committed, false);
  assert.equal(writer.isCurrent(afterReadiness), true);

  assert.equal(writer.observeLifecycle("models-refreshing"), "models-refreshing");
  assert.equal(writer.isCurrent(afterReadiness), false);
  const afterLifecycle = writer.captureAuthority(0);
  assert.equal(writer.observeLifecycle("models-refreshing"), "models-refreshing");
  assert.equal(writer.isCurrent(afterLifecycle), true);
});

test("a current-authority bootstrap cannot regress newer readiness or lifecycle", () => {
  const { writer, values } = fixture();
  writer.observeTransportReady(readiness({ status: "ready", generation: 9 }));
  writer.observeLifecycle("models-refreshing");
  const authority = writer.captureAuthority(0);
  assert.equal(writer.commitBootstrap({
    readiness: readiness({ status: "ready", generation: 1 }),
    lifecycle: "idle",
  }, authority), false);
  assert.equal(values().readiness.generation, 9);
  assert.equal(values().lifecycle, "models-refreshing");
});

test("bootstrap capability requires current matching readiness evidence", () => {
  const { writer, values } = fixture();
  const authority = writer.captureAuthority(0);
  writer.commitBootstrap({
    readiness: readiness({ status: "ready", generation: 2 }),
    lifecycle: "idle",
  }, authority);
  assert.equal(writer.confirmBootstrapCapability({
    readiness: readiness({ status: "ready", generation: 1 }),
    committedModelKey: "test/model",
    modelKeys: ["test/model"],
  }, authority), false);
  assert.equal(writer.confirmBootstrapCapability({
    readiness: readiness({ status: "ready", generation: 2 }),
    committedModelKey: "test/model",
    modelKeys: ["other/model", "test/model", "test/model"],
  }, authority), true);
  assert.deepEqual(values().capability, {
    generation: 2,
    modelKeys: ["other/model", "test/model"],
  });
});

test("malformed lifecycle input preserves the latest admitted lifecycle", () => {
  const { writer, values } = fixture();
  assert.equal(writer.observeLifecycle("resources-reloading"), "resources-reloading");
  assert.equal(writer.observeLifecycle("shutdown-now"), "resources-reloading");
  assert.equal(values().lifecycle, "resources-reloading");
});
