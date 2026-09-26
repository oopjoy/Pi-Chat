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

test("provider thinking maps expose and clamp only their real reasoning levels", () => {
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
  assert.deepEqual(thinkingLevelsForModel(gemini), ["low", "medium", "high"]);
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

test("partial maps retain native defaults and unsupported levels clamp upward before downward", () => {
  assert.deepEqual(thinkingLevelsForModel(reasoningModel), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(thinkingLevelsForModel({ ...reasoningModel, thinkingLevelMap: { xhigh: "xhigh" } }), [
    "off", "minimal", "low", "medium", "high", "xhigh",
  ]);
  const sparse: ModelInfo = {
    ...reasoningModel,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: "max" },
  };
  assert.equal(thinkingLevelForModel(sparse, "medium"), "max");
  assert.equal(thinkingLevelForModel({ ...reasoningModel, thinkingLevelMap: {} }, "max"), "high");
  assert.deepEqual(thinkingLevelsForModel({
    ...reasoningModel,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
  }), []);
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
