import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_STORED_COMPOSER_SELECTIONS,
  SESSION_COMPOSER_SELECTION_STORAGE_KEY,
  loadSessionComposerSelections,
  saveSessionComposerSelections,
} from "../src/web/lib/session-composer-preferences";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) || null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("Composer preference storage retains only bounded route and Thinking intent", () => {
  const storage = new MemoryStorage();
  const selections = new Map([
    ["session-a", {
      revision: 4,
      model: {
        provider: "route",
        id: "same",
        name: "Display-only metadata must not persist",
        api: "openai-responses",
        input: ["text"],
        reasoning: true,
      },
      thinkingLevel: "low" as const,
    }],
  ]);
  saveSessionComposerSelections(selections, storage);
  assert.deepEqual(JSON.parse(storage.getItem(SESSION_COMPOSER_SELECTION_STORAGE_KEY) || "{}"), {
    version: 1,
    entries: [{
      key: "session-a",
      selection: {
        revision: 4,
        model: {
          provider: "route",
          modelId: "same",
          api: "openai-responses",
        },
        thinkingLevel: "low",
      },
    }],
  });
  assert.deepEqual(loadSessionComposerSelections(storage).get("session-a"), {
    revision: 4,
    model: {
      provider: "route",
      id: "same",
      name: "same",
      api: "openai-responses",
    },
    thinkingLevel: "low",
  });
});

test("Composer preference storage rejects malformed input and evicts oldest entries", () => {
  const storage = new MemoryStorage();
  storage.setItem(SESSION_COMPOSER_SELECTION_STORAGE_KEY, "{not JSON");
  assert.deepEqual(loadSessionComposerSelections(storage), new Map());
  storage.setItem(SESSION_COMPOSER_SELECTION_STORAGE_KEY, JSON.stringify({
    version: 1,
    entries: [
      { key: "ok", selection: { revision: 1, thinkingLevel: "not-valid" } },
      { key: "\u0000bad", selection: { revision: 1, thinkingLevel: "low" } },
    ],
  }));
  assert.deepEqual(loadSessionComposerSelections(storage), new Map());

  const selections = new Map<string, { revision: number; thinkingLevel: "low" }>();
  for (let index = 0; index <= MAX_STORED_COMPOSER_SELECTIONS; index += 1)
    selections.set(`session-${index}`, { revision: index + 1, thinkingLevel: "low" });
  saveSessionComposerSelections(selections, storage);
  const loaded = loadSessionComposerSelections(storage);
  assert.equal(loaded.size, MAX_STORED_COMPOSER_SELECTIONS);
  assert.equal(loaded.has("session-0"), false);
  assert.equal(loaded.has(`session-${MAX_STORED_COMPOSER_SELECTIONS}`), true);
});
