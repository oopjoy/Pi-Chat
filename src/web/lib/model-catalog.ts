import type { ModelInfo } from "../../shared/types";

/**
 * Model metadata is a browser-local convenience cache only. The server still
 * rechecks the selected provider/model against the target Runtime at prompt
 * admission; cached input/reasoning fields never authorize a write or image.
 */
export const MODEL_CATALOG_STORAGE_KEY = "pi-chat.model-catalog.v1";
const MAX_CACHED_MODELS = 512;
const MAX_MODEL_FIELD_LENGTH = 240;

function safeText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text.slice(0, MAX_MODEL_FIELD_LENGTH);
}

function normalizeModel(value: unknown): ModelInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const provider = safeText(candidate.provider);
  const id = safeText(candidate.id);
  if (!provider || !id) return null;
  const name = safeText(candidate.name, id) || id;
  const input = Array.isArray(candidate.input)
    ? [...new Set(candidate.input.filter((item): item is string => item === "text" || item === "image"))]
    : undefined;
  const contextWindow = typeof candidate.contextWindow === "number" && Number.isFinite(candidate.contextWindow) && candidate.contextWindow > 0
    ? Math.min(1_000_000_000, Math.floor(candidate.contextWindow))
    : undefined;
  return {
    provider,
    id,
    name,
    ...(typeof candidate.reasoning === "boolean" ? { reasoning: candidate.reasoning } : null),
    ...(input?.length ? { input } : null),
    ...(contextWindow ? { contextWindow } : null),
    ...(candidate.custom === true ? { custom: true } : null),
  };
}

function modelKey(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}\u0000${model.id}`;
}

/** Normalize, deduplicate, and bound an advisory model catalogue. */
export function mergeModelCatalog(
  current: ModelInfo[],
  additions: ModelInfo[],
): ModelInfo[] {
  const result = new Map<string, ModelInfo>();
  for (const candidate of [...current, ...additions]) {
    const model = normalizeModel(candidate);
    if (!model) continue;
    // A newly observed Runtime record is more useful than an older cached
    // description for the same key, while preserving known optional metadata
    // when a readiness frame only carries a sparse model shape.
    const key = modelKey(model);
    const previous = result.get(key);
    result.set(key, previous ? { ...previous, ...model } : model);
  }
  return [...result.values()].slice(-MAX_CACHED_MODELS);
}

export function loadModelCatalog(): ModelInfo[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MODEL_CATALOG_STORAGE_KEY) || "[]");
    return Array.isArray(raw) ? mergeModelCatalog([], raw as ModelInfo[]) : [];
  } catch {
    return [];
  }
}

export function saveModelCatalog(models: ModelInfo[]): void {
  try {
    localStorage.setItem(
      MODEL_CATALOG_STORAGE_KEY,
      JSON.stringify(mergeModelCatalog([], models)),
    );
  } catch {
    // Private browsing/quota failures must not affect Composer interaction.
  }
}
