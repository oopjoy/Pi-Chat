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

export type SelectedRouteValidation =
  | { ok: true; model: ModelInfo }
  | { ok: false; reason: "inventory-pending" | "route-missing" };

/** Local guard for an explicitly staged route; it performs no network request and the server remains authoritative. */
export function validateSelectedRoute(
  models: readonly ModelInfo[],
  provider: string,
  modelId: string,
  api?: string,
  inventoryPending = false,
): SelectedRouteValidation {
  if (inventoryPending) return { ok: false, reason: "inventory-pending" };
  const key = `${provider}\u0000${modelId}`;
  const exact = models.find((model) =>
    `${model.provider}\u0000${model.id}` === key
    && (api ? model.api === api : true),
  );
  return exact ? { ok: true, model: exact } : { ok: false, reason: "route-missing" };
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
            ...(selection.model.api ? { api: selection.model.api } : null),
          },
        }
      : null),
    ...(selection.thinkingLevel
      ? { thinkingLevel: selection.thinkingLevel }
      : null),
  };
  return settings.model || settings.thinkingLevel ? settings : undefined;
}
