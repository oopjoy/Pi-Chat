import assert from "node:assert/strict";
import test from "node:test";
import { ModelCatalogueRevisionGate } from "../src/web/application/model-catalogue-revision-gate";

test("ordered SSE accepts equal-revision refinements and rejects regressions", () => {
  const gate = new ModelCatalogueRevisionGate();
  assert.equal(gate.admitSse(2), true);
  assert.equal(gate.admitSse(2), true);
  assert.equal(gate.admitSse(1), false);
});

test("same-revision SSE retires a held Bootstrap authority", () => {
  const gate = new ModelCatalogueRevisionGate();
  assert.equal(gate.admitBootstrap(1, gate.captureAuthority()), true);
  const held = gate.captureAuthority();
  assert.equal(gate.admitSse(2), true);
  assert.equal(gate.admitBootstrap(2, held), false);
});

test("a numerically newer Bootstrap may beat an intervening observation", () => {
  const gate = new ModelCatalogueRevisionGate();
  assert.equal(gate.admitBootstrap(1, gate.captureAuthority()), true);
  const held = gate.captureAuthority();
  assert.equal(gate.admitSse(2), true);
  assert.equal(gate.admitBootstrap(3, held), true);
});

test("mutation responses require a strictly newer revision once revisioned", () => {
  const gate = new ModelCatalogueRevisionGate();
  assert.equal(gate.admitSse(4), true);
  assert.equal(gate.admitBootstrap(4), false);
  assert.equal(gate.admitBootstrap(3), false);
  assert.equal(gate.admitBootstrap(5), true);
});

test("legacy unrevisioned snapshots cannot overwrite revisioned state", () => {
  const gate = new ModelCatalogueRevisionGate();
  assert.equal(gate.admitBootstrap(undefined, gate.captureAuthority()), true);
  assert.equal(gate.admitSse(1), true);
  assert.equal(gate.admitBootstrap(undefined, gate.captureAuthority()), false);
  assert.equal(gate.admitSse(undefined), false);
  assert.equal(gate.admitSse(Number.NaN), false);
});

test("process replacement permits a lower replacement revision", () => {
  const gate = new ModelCatalogueRevisionGate();
  assert.equal(gate.admitSse(9), true);
  const oldProcess = gate.captureAuthority();
  gate.resetForProcessReplacement();
  assert.equal(gate.admitBootstrap(1, oldProcess), false);
  assert.equal(gate.admitBootstrap(1, gate.captureAuthority()), true);
});
