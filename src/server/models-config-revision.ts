import { createHash } from "node:crypto";
import type { ModelInfo } from "../shared/types.js";

/** Server-side identity of models.json, including secrets never sent to the browser. */
export function modelsConfigFingerprint(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
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
