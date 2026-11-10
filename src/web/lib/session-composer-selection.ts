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

/** Reasoning models share seven user-facing semantic slots; only non-reasoning models lock to off. */
export function thinkingLevelsForModel(
  model: ModelInfo | null | undefined,
  models: readonly ModelInfo[] = [],
): readonly ThinkingLevel[] {
  const resolved = resolveCatalogueModel(model, models);
  if (resolved?.reasoning === false) return ["off"];
  // Custom models describe one "thinking" switch, not Pi's provider-specific
  // ladder, so they default to four coarse levels instead of all seven slots.
  if (isCustomModel(resolved)) return CUSTOM_MODEL_THINKING_LEVELS;
  return THINKING_LEVELS;
}

/** Custom (models.json) models default to low/high/xhigh/max only. */
export const CUSTOM_MODEL_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "low",
  "high",
  "xhigh",
  "max",
];

function isCustomModel(model: ModelInfo | null | undefined): boolean {
  return model?.custom === true || model?.source === "models-json";
}

/**
 * Pi's `get_state` model is a route (provider/id/api) without catalogue
 * metadata. Resolve it against the annotated catalogue so `custom`/
 * `thinkingLevelMap` still describe the model being displayed or sent to.
 */
export function resolveCatalogueModel(
  model: ModelInfo | null | undefined,
  models: readonly ModelInfo[] = [],
): ModelInfo | null | undefined {
  if (!model || isCustomModel(model) || model.thinkingLevelMap) return model;
  return models.find((candidate) =>
    candidate.provider === model.provider
    && candidate.id === model.id
    && (model.api ? candidate.api === model.api : true),
  ) ?? model;
}

function mappedThinkingLevelsForModel(
  model: ModelInfo | null | undefined,
  models: readonly ModelInfo[] = [],
): readonly ThinkingLevel[] {
  const resolved = resolveCatalogueModel(model, models);
  if (resolved?.reasoning === false) return ["off"];
  const map = resolved?.thinkingLevelMap;
  if (!map || Object.keys(map).length === 0)
    return isCustomModel(resolved) ? CUSTOM_MODEL_THINKING_LEVELS : THINKING_LEVELS;
  const supported = thinkingLevelsForModel(resolved).filter(
    (level) => typeof map[level] === "string",
  );
  // Contradictory metadata must not erase reasoning controls. Runtime readback
  // remains authoritative if an adapter advertises reasoning but maps no level.
  return supported.length ? supported : thinkingLevelsForModel(resolved);
}

/** Map a semantic slot onto the model's real levels, searching upward before downward. */
export function thinkingLevelForModel(
  model: ModelInfo | null | undefined,
  level: ThinkingLevel,
  models: readonly ModelInfo[] = [],
): ThinkingLevel {
  const supported = mappedThinkingLevelsForModel(model, models);
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
  // A catalogue-annotated view of the Runtime's own model keeps custom-model
  // and reasoning rules correct when no explicit model was staged.
  const effective = model === undefined || model === null
    ? resolveCatalogueModel(state.model, models)
    : model;
  return {
    ...state,
    ...(model !== undefined ? { model } : null),
    ...(effective?.reasoning === false
      ? { thinkingLevel: "off" as const }
      : selection.thinkingLevel !== undefined
        ? { thinkingLevel: thinkingLevelForModel(effective, selection.thinkingLevel, models) }
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
  /** Catalogue-clamp source when the selection carries no model of its own. */
  displayedModel?: ModelInfo | null,
): PromptSettingsSnapshot | undefined {
  if (!selection) return undefined;
  const model = selectedCatalogueModel(selection, models);
  const clampSource = model !== undefined
    ? model
    : resolveCatalogueModel(displayedModel, models);
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
    ...(clampSource?.reasoning === false
      ? null
      : selection.thinkingLevel
        ? {
            thinkingLevel: thinkingLevelForModel(
              clampSource,
              selection.thinkingLevel,
              models,
            ),
          }
        : null),
  };
  return settings.model || settings.thinkingLevel ? settings : undefined;
}
