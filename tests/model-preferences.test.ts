import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelPreferencesStore, modelPreferenceKey } from "../src/server/model-preferences";
import { composerModelSections } from "../src/web/lib/model-preferences";

test("model preferences write Pi defaults without clobbering other settings, and keep favorites local", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-model-prefs-"));
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({ $schema: "https://pi.dev/schemas/settings.schema.json", theme: "dark" }, null, 2));
    const store = new ModelPreferencesStore(root);
    await store.apply({ default: { provider: "zai", id: "glm-5" } });
    await store.apply({ favorite: { provider: "openai", id: "gpt-5", on: true } });
    await store.apply({ used: { provider: "zai", id: "glm-5" } });
    const snapshot = await store.read();
    assert.equal(snapshot.defaultProvider, "zai");
    assert.equal(snapshot.defaultModel, "glm-5");
    assert.deepEqual(snapshot.favorites, ["openai/gpt-5"]);
    assert.deepEqual(snapshot.recent, ["zai/glm-5"]);
    const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.defaultProvider, "zai");
    const prefs = JSON.parse(await readFile(join(root, "pi-chat-model-prefs.json"), "utf8"));
    assert.equal(prefs.theme, undefined);
    assert.equal(modelPreferenceKey("zai", "glm-5"), "zai/glm-5");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composer sections put current, favorites and recent above the remaining catalogue", () => {
  const models = [
    { provider: "openai", id: "gpt", name: "GPT" },
    { provider: "zai", id: "glm-5", name: "GLM-5" },
    { provider: "deepseek", id: "v4", name: "V4" },
  ];
  const sections = composerModelSections(models, models[1], ["openai/gpt"], ["deepseek/v4"]);
  assert.deepEqual(sections.map((section) => section.id), ["current", "favorites", "recent"]);
  assert.equal(sections[0].models[0].id, "glm-5");
  assert.equal(sections[1].models[0].id, "gpt");
  assert.equal(sections[2].models[0].id, "v4");
});
