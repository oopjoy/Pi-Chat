import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInfo, PiState } from "../src/shared/types";
import {
  composerStateForSelection,
  modelSelectionPatch,
  promptSettingsForSelection,
  thinkingLevelForModel,
  thinkingLevelsForModel,
  stageSessionComposerSelection,
  THINKING_LEVELS,
} from "../src/web/lib/session-composer-selection";

const reasoningModel: ModelInfo = {
  provider: "test",
  id: "reasoning",
  name: "Reasoning",
  reasoning: true,
};
const composerModel: ModelInfo = {
  provider: "cursor",
  id: "composer-2.5",
  name: "Composer 2.5",
  reasoning: false,
};
const runtimeState: PiState = {
  model: reasoningModel,
  thinkingLevel: "high",
  isStreaming: false,
};

test("the first Model choice preserves an implicit Runtime reasoning level across a non-reasoning selection", () => {
  const composer = stageSessionComposerSelection(
    undefined,
    modelSelectionPatch(runtimeState, undefined, composerModel, [
      reasoningModel,
      composerModel,
    ]),
  );
  assert.equal(composer.thinkingLevel, "high");
  assert.equal(
    composerStateForSelection(runtimeState, composer, [
      reasoningModel,
      composerModel,
    ]).thinkingLevel,
    "off",
  );

  const reasoning = stageSessionComposerSelection(
    composer,
    modelSelectionPatch(runtimeState, composer, reasoningModel, [
      reasoningModel,
      composerModel,
    ]),
  );
  assert.equal(reasoning.thinkingLevel, "high");
  assert.equal(
    composerStateForSelection(runtimeState, reasoning, [
      reasoningModel,
      composerModel,
    ]).thinkingLevel,
    "high",
  );
  assert.deepEqual(
    promptSettingsForSelection(reasoning, [reasoningModel, composerModel]),
    {
      model: { provider: "test", modelId: "reasoning" },
      thinkingLevel: "high",
    },
  );
});

test("provider thinking maps normalize seven semantic levels to real reasoning values", () => {
  const gemini: ModelInfo = {
    provider: "cursor",
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
  };
  assert.deepEqual(thinkingLevelsForModel(gemini), THINKING_LEVELS);
  assert.equal(thinkingLevelForModel(gemini, "off"), "low");
  assert.equal(thinkingLevelForModel(gemini, "xhigh"), "high");

  const stale = stageSessionComposerSelection(undefined, {
    model: gemini,
    thinkingLevel: "off",
  });
  assert.equal(
    composerStateForSelection(runtimeState, stale, [gemini]).thinkingLevel,
    "low",
  );
  assert.deepEqual(promptSettingsForSelection(stale, [gemini]), {
    model: { provider: "cursor", modelId: "gemini-3.8-flash" },
    thinkingLevel: "low",
  });
});

test("all reasoning models retain seven semantic slots while maps clamp upward before downward", () => {
  assert.deepEqual(thinkingLevelsForModel(reasoningModel), THINKING_LEVELS);
  assert.deepEqual(
    thinkingLevelsForModel({ ...reasoningModel, thinkingLevelMap: {} }),
    THINKING_LEVELS,
  );
  assert.deepEqual(
    thinkingLevelsForModel({ ...reasoningModel, thinkingLevelMap: { xhigh: "xhigh" } }),
    THINKING_LEVELS,
  );
  const sparse: ModelInfo = {
    ...reasoningModel,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: "max" },
  };
  assert.equal(thinkingLevelForModel(sparse, "medium"), "max");
  assert.equal(thinkingLevelForModel({ ...reasoningModel, thinkingLevelMap: {} }, "max"), "max");
  assert.equal(thinkingLevelForModel({
    ...reasoningModel,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
  }, "max"), "max");
});

test("custom models expose only the four coarse thinking levels", () => {
  const custom: ModelInfo = {
    provider: "local",
    id: "kimi-k2",
    name: "Kimi K2",
    reasoning: true,
    source: "models-json",
    custom: true,
  };
  assert.deepEqual(thinkingLevelsForModel(custom), ["low", "high", "xhigh", "max"]);
  assert.deepEqual(thinkingLevelsForModel({ ...custom, thinkingLevelMap: {} }), ["low", "high", "xhigh", "max"]);
  // Stored provider-specific levels clamp into the coarse slots instead of
  // showing an option the selector does not offer.
  assert.equal(thinkingLevelForModel(custom, "minimal"), "low");
  assert.equal(thinkingLevelForModel(custom, "off"), "low");
  assert.equal(thinkingLevelForModel(custom, "medium"), "high");
  assert.equal(thinkingLevelForModel(custom, "max"), "max");
  // A runtime/Provider model keeps the full seven-slot ladder.
  assert.deepEqual(thinkingLevelsForModel({ ...custom, source: "pi-runtime", custom: false }), THINKING_LEVELS);
});

test("a Runtime-shaped model resolves catalogue metadata for custom thinking levels", () => {
  // Pi's get_state carries provider/id/api only; the custom flag comes from the
  // annotated catalogue, so both display and send must resolve through it.
  const runtimeShaped: ModelInfo = { provider: "local", id: "kimi-k2", name: "Kimi K2", reasoning: true };
  const catalogue: ModelInfo[] = [{ ...runtimeShaped, source: "models-json", custom: true }];
  assert.deepEqual(thinkingLevelsForModel(runtimeShaped), THINKING_LEVELS, "without a catalogue it stays a provider model");
  assert.deepEqual(thinkingLevelsForModel(runtimeShaped, catalogue), ["low", "high", "xhigh", "max"]);
  assert.equal(thinkingLevelForModel(runtimeShaped, "medium", catalogue), "high");
  const selection = stageSessionComposerSelection(undefined, {
    model: runtimeShaped,
    thinkingLevel: "minimal",
  });
  assert.deepEqual(promptSettingsForSelection(selection, catalogue), {
    model: { provider: "local", modelId: "kimi-k2" },
    thinkingLevel: "low",
  });
  assert.equal(
    composerStateForSelection({ ...runtimeState, model: runtimeShaped }, selection, catalogue).thinkingLevel,
    "low",
  );
  // Thinking-only intent still clamps through the displayed model, without
  // emitting a model command of its own.
  const thinkingOnly = stageSessionComposerSelection(undefined, { thinkingLevel: "medium" });
  assert.deepEqual(promptSettingsForSelection(thinkingOnly, catalogue, runtimeShaped), { thinkingLevel: "high" });
  assert.deepEqual(promptSettingsForSelection(thinkingOnly, catalogue), { thinkingLevel: "medium" });
});

test("a stale implicit off is not promoted to durable reasoning intent", () => {
  const staleOffState: PiState = {
    ...runtimeState,
    thinkingLevel: "off",
  };
  assert.deepEqual(
    modelSelectionPatch(staleOffState, undefined, reasoningModel, [
      reasoningModel,
    ]),
    { model: reasoningModel },
  );
});

test("a non-reasoning model temporarily suppresses rather than destroys explicit thinking intent", () => {
  const high = stageSessionComposerSelection(undefined, { thinkingLevel: "high" });
  const composer = stageSessionComposerSelection(high, { model: composerModel });
  assert.equal(composer.thinkingLevel, "high");
  assert.deepEqual(promptSettingsForSelection(composer), {
    model: { provider: "cursor", modelId: "composer-2.5" },
  });

  const reasoning = stageSessionComposerSelection(composer, { model: reasoningModel });
  assert.equal(reasoning.thinkingLevel, "high");
  assert.deepEqual(promptSettingsForSelection(reasoning), {
    model: { provider: "test", modelId: "reasoning" },
    thinkingLevel: "high",
  });
});

test("a non-reasoning selection displays off without making off a durable prompt override", () => {
  const stale = stageSessionComposerSelection(undefined, {
    model: composerModel,
    thinkingLevel: "off",
  });
  const display = composerStateForSelection(runtimeState, stale);
  assert.equal(display.model?.id, "composer-2.5");
  assert.equal(display.thinkingLevel, "off");
  assert.deepEqual(promptSettingsForSelection(stale), {
    model: { provider: "cursor", modelId: "composer-2.5" },
  });
});

test("catalogue capability repairs a restored selection before display and send", () => {
  const restored = stageSessionComposerSelection(undefined, {
    model: {
      provider: composerModel.provider,
      id: composerModel.id,
      name: composerModel.id,
    },
    thinkingLevel: "high",
  });
  const display = composerStateForSelection(runtimeState, restored, [composerModel]);
  assert.equal(display.model?.reasoning, false);
  assert.equal(display.thinkingLevel, "off");
  assert.deepEqual(promptSettingsForSelection(restored, [composerModel]), {
    model: { provider: "cursor", modelId: "composer-2.5" },
  });
});
