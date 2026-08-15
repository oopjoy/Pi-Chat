import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PiState } from "../src/shared/types";
import { ComposerControls } from "../src/web/components/ComposerControls";

const baseState = (): PiState => ({
  model: null,
  isStreaming: false,
  isCompacting: false,
});

function render(state: PiState): string {
  return renderToStaticMarkup(createElement(ComposerControls, {
    state,
    models: [],
    disabled: false,
    onModelChange: () => undefined,
    onThinkingChange: () => undefined,
    gateAvailable: true,
    gateMode: "ask",
    onGateModeChange: () => undefined,
  }));
}

test("Composer shows the unified yellow lightning immediately right of context usage only in Fast mode", () => {
  const normal = render(baseState());
  assert.doesNotMatch(normal, /fast-mode-indicator/);
  assert.doesNotMatch(normal, /Fast 模式已开启/);

  const fast = render({ ...baseState(), fastModeActive: true });
  assert.match(fast, /composer-usage is-unavailable has-fast-mode/);
  assert.match(fast, /<span>—<\/span><span class="fast-mode-indicator"/);
  assert.match(fast, /Fast 模式已开启/);
  assert.match(fast, /<svg[^>]*viewBox="0 0 24 24"/);
});
