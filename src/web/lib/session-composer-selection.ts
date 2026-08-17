import type {
  ModelInfo,
  PiState,
  PromptSettingsSnapshot,
  ThinkingLevel,
} from "../../shared/types";

/**
 * Browser-local desired selection for one writable Composer target. It is
 * deliberately distinct from PiState: PiState describes the JSONL/Runtime
 * projection, while this value is what the next ordinary prompt must carry.
 */
export interface SessionComposerSelection {
  revision: number;
  model?: ModelInfo | null;
  thinkingLevel?: ThinkingLevel;
}

export type SessionComposerSelectionPatch = Pick<
  SessionComposerSelection,
  "model" | "thinkingLevel"
>;

/** Merge a new user choice without allowing callers to mutate a prior snapshot. */
export function stageSessionComposerSelection(
  previous: SessionComposerSelection | undefined,
  patch: SessionComposerSelectionPatch,
): SessionComposerSelection {
  return {
    ...(previous || { revision: 0 }),
    ...patch,
    revision: (previous?.revision || 0) + 1,
  };
}

/** The Composer displays the intended next-turn selection, never a stale Runtime value. */
export function composerStateForSelection(
  state: PiState,
  selection: SessionComposerSelection | undefined,
): PiState {
  if (!selection) return state;
  return {
    ...state,
    ...(selection.model !== undefined ? { model: selection.model } : null),
    ...(selection.thinkingLevel !== undefined
      ? { thinkingLevel: selection.thinkingLevel }
      : null),
  };
}

/**
 * Only explicit user choices travel with a prompt. Omitted fields preserve the
 * target Runtime's existing setting; private UI revision data never leaves the
 * browser.
 */
export function promptSettingsForSelection(
  selection: SessionComposerSelection | undefined,
): PromptSettingsSnapshot | undefined {
  if (!selection) return undefined;
  const settings: PromptSettingsSnapshot = {
    ...(selection.model
      ? {
          model: {
            provider: selection.model.provider,
            modelId: selection.model.id,
          },
        }
      : null),
    ...(selection.thinkingLevel
      ? { thinkingLevel: selection.thinkingLevel }
      : null),
  };
  return settings.model || settings.thinkingLevel ? settings : undefined;
}
