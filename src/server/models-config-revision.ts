import { createHash } from "node:crypto";
import type { ModelInfo } from "../shared/types.js";

/** Server-side identity of models.json, including secrets never sent to the browser. */
export function modelsConfigFingerprint(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function modelRouteKey(model: Pick<ModelInfo, "provider" | "id" | "api">): string {
  return [model.provider, model.id, model.api || ""].join(String.fromCharCode(0));
}

/** Host routes and whole Providers removed from models.json until the user puts them back. */
export interface RemovedHostCatalogue {
  modelKeys: Set<string>;
  providers: Set<string>;
}

export function createRemovedHostCatalogue(): RemovedHostCatalogue {
  return { modelKeys: new Set<string>(), providers: new Set<string>() };
}

/**
 * models.json is the authority for custom Providers. A Runtime catalogue can
 * keep serving a deleted Provider until it reloads, so the published list must
 * remember those removals instead of unioning the stale cache back in.
 */
export function rememberRemovedHostCatalogue(
  removed: RemovedHostCatalogue,
  previousHost: readonly Pick<ModelInfo, "provider" | "id" | "api">[],
  nextHost: readonly Pick<ModelInfo, "provider" | "id" | "api">[],
): void {
  const nextKeys = new Set(nextHost.map(modelRouteKey));
  const nextProviders = new Set(nextHost.map((model) => model.provider));
  const previousProviders = new Set(previousHost.map((model) => model.provider));
  for (const model of previousHost) {
    const key = modelRouteKey(model);
    if (!nextKeys.has(key)) removed.modelKeys.add(key);
  }
  for (const provider of previousProviders) {
    if (!nextProviders.has(provider)) removed.providers.add(provider);
  }
  for (const key of nextKeys) removed.modelKeys.delete(key);
  for (const provider of nextProviders) removed.providers.delete(provider);
}

export function isRemovedHostModel(
  model: Pick<ModelInfo, "provider" | "id" | "api">,
  removed: RemovedHostCatalogue,
): boolean {
  return removed.providers.has(model.provider) || removed.modelKeys.has(modelRouteKey(model));
}

export function mergeHostAndRuntimeModels(
  runtimeModels: ModelInfo[],
  hostModels: ModelInfo[],
  removed: RemovedHostCatalogue = createRemovedHostCatalogue(),
): ModelInfo[] {
  const result = new Map<string, ModelInfo>();
  for (const model of runtimeModels) {
    if (isRemovedHostModel(model, removed)) continue;
    result.set(modelRouteKey(model), model);
  }
  for (const model of hostModels) {
    const key = modelRouteKey(model);
    result.set(key, { ...result.get(key), ...model });
  }
  return [...result.values()];
}

/**
 * The Host catalogue used for labels and SSE. Connection fields (baseUrl, apiKey,
 * maxTokens) are intentionally absent: they are runtime configuration, not display.
 */
export function hostVisibleModelsFromConfig(raw: unknown): ModelInfo[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const providers = (raw as { providers?: Record<string, { models?: unknown[]; api?: unknown }> }).providers;
  if (!providers || typeof providers !== "object") return [];
  const models: ModelInfo[] = [];
  for (const [provider, config] of Object.entries(providers)) {
    for (const item of config?.models || []) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      if (typeof value.id !== "string" || !value.id) continue;
      const configuredInput = Array.isArray(value.input)
        ? value.input.filter((entry): entry is string => entry === "text" || entry === "image")
        : [];
      models.push({
        provider,
        id: value.id,
        ...(typeof value.api === "string"
          ? { api: value.api }
          : typeof config.api === "string"
            ? { api: config.api }
            : null),
        name: typeof value.name === "string" && value.name ? value.name : value.id,
        source: "models-json",
        authMode: "api-key",
        reasoning: value.reasoning === true,
        input: configuredInput.length ? configuredInput : value.imageInput === true ? ["text", "image"] : ["text"],
        contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : undefined,
        custom: true,
      });
    }
  }
  return models;
}
