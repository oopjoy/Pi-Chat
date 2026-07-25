import assert from "node:assert/strict";
import test from "node:test";
import { gateModeFromCommand, gateModeFromNotice } from "../src/web/lib/gate-mode";

test("gate mode parser recognizes aliases and runtime status notifications", () => {
  assert.equal(gateModeFromCommand("/gate strict"), "strict");
  assert.equal(gateModeFromCommand("/gate next"), "once");
  assert.equal(gateModeFromCommand("/gate allow"), "open");
  assert.equal(gateModeFromCommand("/gate status"), null);
  assert.equal(gateModeFromNotice("Gate mode: open\nCommands: /gate open"), "open");
  assert.equal(gateModeFromNotice("Gate mode: strict\nwrite/edit will ask for confirmation."), "strict");
  assert.equal(gateModeFromNotice("Gate mode: once\nThe next write will be allowed."), "once");
  // Legacy free-form notices from older adapters.
  assert.equal(gateModeFromNotice("Gate opened for this Pi runtime. write/edit will be allowed."), "open");
  assert.equal(gateModeFromNotice("Gate strict mode enabled. write/edit will ask."), "strict");
  assert.equal(gateModeFromNotice("Gate will allow the next write/edit/destructive bash call."), "once");
  assert.equal(gateModeFromNotice("Gate one-shot allow used for edit: app.ts"), "strict");
});
