import assert from "node:assert/strict";
import test from "node:test";
import { gateModeFromCommand, gateModeFromNotice } from "../src/web/lib/gate-mode";

test("gate mode parser recognizes aliases and runtime status notifications", () => {
  assert.equal(gateModeFromCommand("/gate strict"), "strict");
  assert.equal(gateModeFromCommand("/gate next"), "once");
  assert.equal(gateModeFromCommand("/gate allow"), "open");
  assert.equal(gateModeFromCommand("/gate status"), null);
  assert.equal(gateModeFromNotice("Gate mode: open\nCommands: /gate open"), "open");
  assert.equal(gateModeFromNotice("Gate strict mode enabled"), null);
});
