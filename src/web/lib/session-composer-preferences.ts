import type { ModelInfo, ThinkingLevel } from "../../shared/types";
import type { SessionComposerSelection } from "./session-composer-selection";

/**
 * Browser-tab-local desired next-turn choices. This intentionally stores only
 * route identity and thinking intent: PiState and Gate confirmation remain
 * Runtime/JSONL facts and are never reconstructed from this cache.
 */
export const SESSION_COMPOSER_SELECTION_STORAGE_KEY =
  "pi-chat.composer-selection.v1";
export const MAX_STORED_COMPOSER_SELECTIONS = 32;
const STORAGE_SCHEMA_VERSION = 1;
const MAX_PROVIDER_LENGTH = 80;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_API_LENGTH = 120;
const MAX_KEY_LENGTH = 128;

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type ComposerSelectionStorage = Pick<Storage, "getItem" | "setItem">;

type StoredComposerSelection = {
  revision: number;
  model?: { provider: string; modelId: string; api?: string };
  thinkingLevel?: ThinkingLevel;
};

type StoredSelectionDocument = {
  version: number;
  entries: Array<{ key: string; selection: StoredComposerSelection }>;
};

function browserSessionStorage(): ComposerSelectionStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function validString(value: unknown, maximum: number): value is string {
  return typeof value === "string" &&
    Boolean(value.trim()) &&
    value.trim().length <= maximum &&
    !/[\u0000-\u001f]/.test(value);
}

function validKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_KEY_LENGTH &&
    /^[A-Za-z0-9_.:-]+$/.test(value);
}

function restoredModel(value: unknown): ModelInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    !validString(candidate.provider, MAX_PROVIDER_LENGTH) ||
    !validString(candidate.modelId, MAX_MODEL_ID_LENGTH)
  )
    return undefined;
  const provider = candidate.provider.trim();
  const id = candidate.modelId.trim();
  const api = candidate.api;
  if (api !== undefined && !validString(api, MAX_API_LENGTH)) return undefined;
  return {
    provider,
    id,
    // The authoritative catalogue supplies presentation metadata after reload.
    // An ID fallback keeps the desired route visible until then.
    name: id,
    ...(typeof api === "string" ? { api: api.trim() } : null),
  };
}

function restoredSelection(value: unknown): SessionComposerSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const model = restoredModel(candidate.model);
  const thinkingLevel = THINKING_LEVELS.has(candidate.thinkingLevel as ThinkingLevel)
    ? candidate.thinkingLevel as ThinkingLevel
    : undefined;
  if (!model && !thinkingLevel) return undefined;
  const revision =
    typeof candidate.revision === "number" &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision > 0 &&
    candidate.revision <= Number.MAX_SAFE_INTEGER - 1
      ? candidate.revision
      : 1;
  return {
    revision,
    ...(model ? { model } : null),
    ...(thinkingLevel ? { thinkingLevel } : null),
  };
}

function storedSelection(
  selection: SessionComposerSelection,
): StoredComposerSelection | undefined {
  const model = selection.model;
  const route = model && validString(model.provider, MAX_PROVIDER_LENGTH) &&
    validString(model.id, MAX_MODEL_ID_LENGTH) &&
    (model.api === undefined || validString(model.api, MAX_API_LENGTH))
    ? {
        provider: model.provider.trim(),
        modelId: model.id.trim(),
        ...(model.api ? { api: model.api.trim() } : null),
      }
    : undefined;
  const thinkingLevel = THINKING_LEVELS.has(selection.thinkingLevel as ThinkingLevel)
    ? selection.thinkingLevel
    : undefined;
  if (!route && !thinkingLevel) return undefined;
  return {
    revision:
      Number.isSafeInteger(selection.revision) && selection.revision > 0
        ? selection.revision
        : 1,
    ...(route ? { model: route } : null),
    ...(thinkingLevel ? { thinkingLevel } : null),
  };
}

/** Safely restores a bounded, tab-local next-turn cache without Runtime I/O. */
export function loadSessionComposerSelections(
  storage = browserSessionStorage(),
): Map<string, SessionComposerSelection> {
  if (!storage) return new Map();
  try {
    const parsed = JSON.parse(
      storage.getItem(SESSION_COMPOSER_SELECTION_STORAGE_KEY) || "null",
    ) as Partial<StoredSelectionDocument> | null;
    if (!parsed || parsed.version !== STORAGE_SCHEMA_VERSION || !Array.isArray(parsed.entries))
      return new Map();
    const selections = new Map<string, SessionComposerSelection>();
    for (const entry of parsed.entries.slice(-MAX_STORED_COMPOSER_SELECTIONS)) {
      if (!entry || !validKey(entry.key)) continue;
      const selection = restoredSelection(entry.selection);
      if (!selection) continue;
      // Retain last occurrence deterministically and make it most-recent.
      selections.delete(entry.key);
      selections.set(entry.key, selection);
    }
    return selections;
  } catch {
    return new Map();
  }
}

/** Persists bounded browser intent only; storage failure must never block Send. */
export function saveSessionComposerSelections(
  selections: ReadonlyMap<string, SessionComposerSelection>,
  storage = browserSessionStorage(),
): void {
  if (!storage) return;
  const entries: StoredSelectionDocument["entries"] = [];
  for (const [key, selection] of selections) {
    if (!validKey(key)) continue;
    const serialized = storedSelection(selection);
    if (serialized) entries.push({ key, selection: serialized });
  }
  try {
    storage.setItem(
      SESSION_COMPOSER_SELECTION_STORAGE_KEY,
      JSON.stringify({
        version: STORAGE_SCHEMA_VERSION,
        entries: entries.slice(-MAX_STORED_COMPOSER_SELECTIONS),
      } satisfies StoredSelectionDocument),
    );
  } catch {
    // Private mode/quota failures leave the in-memory selection usable.
  }
}
