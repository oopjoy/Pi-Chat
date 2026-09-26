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

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const THINKING_LEVEL_SET = new Set(THINKING_LEVELS);

/** Match Pi: null disables a level; only xhigh/max require an explicit mapping. */
export function thinkingLevelsForModel(
  model: ModelInfo | null | undefined,
): readonly ThinkingLevel[] {
  if (model?.reasoning === false) return ["off"];
  // Do not infer capabilities before an authoritative model is available.
  if (model?.reasoning !== true) return THINKING_LEVELS;
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

/** Pi searches upward first, then downward, rather than choosing the closest level. */
export function thinkingLevelForModel(
  model: ModelInfo | null | undefined,
  level: ThinkingLevel,
): ThinkingLevel {
  const supported = thinkingLevelsForModel(model);
  if (supported.includes(level)) return level;
  const requestedIndex = THINKING_LEVELS.indexOf(level);
  return supported.find((candidate) => THINKING_LEVELS.indexOf(candidate) >= requestedIndex)
    ?? supported.at(-1)
    ?? "off";
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

/**
 * Preserve the currently effective reasoning level when Model is the first
 * Composer preference a user changes. A non-reasoning Model may display off,
 * but that temporary Runtime clamp must not erase an otherwise implicit
 * reasoning preference when the user later switches back.
 */
export function modelSelectionPatch(
  state: PiState,
  selection: SessionComposerSelection | undefined,
  model: ModelInfo,
  models: readonly ModelInfo[] = [],
): SessionComposerSelectionPatch {
  if (selection?.thinkingLevel !== undefined) return { model };
  const current = composerStateForSelection(state, selection, models);
  const thinkingLevel =
    current.thinkingLevel &&
    THINKING_LEVEL_SET.has(current.thinkingLevel as ThinkingLevel)
      ? (current.thinkingLevel as ThinkingLevel)
      : undefined;
  return {
    model,
    ...(current.model?.reasoning !== false && thinkingLevel && thinkingLevel !== "off"
      ? { thinkingLevel }
      : null),
  };
}

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

function selectedCatalogueModel(
  selection: SessionComposerSelection | undefined,
  models: readonly ModelInfo[],
): ModelInfo | null | undefined {
  const selected = selection?.model;
  if (selected === undefined || selected === null) return selected;
  const matches = models.filter((candidate) =>
    candidate.provider === selected.provider
    && candidate.id === selected.id
    && (selected.api ? candidate.api === selected.api : true),
  );
  return matches.length === 1 ? matches[0] : selected;
}

/** The Composer displays the intended next-turn selection, never a stale Runtime value. */
export function composerStateForSelection(
  state: PiState,
  selection: SessionComposerSelection | undefined,
  models: readonly ModelInfo[] = [],
): PiState {
  if (!selection) return state;
  const model = selectedCatalogueModel(selection, models);
  return {
    ...state,
    ...(model !== undefined ? { model } : null),
    ...(model?.reasoning === false
      ? { thinkingLevel: "off" as const }
      : selection.thinkingLevel !== undefined
        ? { thinkingLevel: thinkingLevelForModel(model, selection.thinkingLevel) }
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
  models: readonly ModelInfo[] = [],
): PromptSettingsSnapshot | undefined {
  if (!selection) return undefined;
  const model = selectedCatalogueModel(selection, models);
  const settings: PromptSettingsSnapshot = {
    ...(model
      ? {
          model: {
            provider: model.provider,
            modelId: model.id,
            ...(model.api ? { api: model.api } : null),
          },
        }
      : null),
    ...(model?.reasoning === false
      ? null
      : selection.thinkingLevel
        ? {
            thinkingLevel: thinkingLevelForModel(
              model,
              selection.thinkingLevel,
            ),
          }
        : null),
  };
  return settings.model || settings.thinkingLevel ? settings : undefined;
}
