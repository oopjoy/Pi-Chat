import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./file-transaction.js";

export const MAX_MODEL_FAVORITES = 24;
export const MAX_MODEL_RECENT = 8;

export function modelPreferenceKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

export type ModelPreferencesSnapshot = {
  defaultProvider: string;
  defaultModel: string;
  favorites: string[];
  recent: string[];
};

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const key = stringField(item);
    if (!key || !/^[A-Za-z0-9._-]+\/[^\s\u0000-\u001f]+$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
    if (result.length >= limit) break;
  }
  return result;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`无法解析 ${path}，请先修复 JSON`);
  }
}

function validateRef(provider: string, id: string): { provider: string; id: string } {
  const cleanProvider = provider.trim();
  const cleanId = id.trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(cleanProvider)) throw new Error("Provider 格式无效");
  if (!cleanId || cleanId.length > 200 || /[\s\u0000-\u001f]/.test(cleanId)) throw new Error("Model ID 格式无效");
  return { provider: cleanProvider, id: cleanId };
}

export class ModelPreferencesStore {
  constructor(readonly agentDir: string) {}

  get settingsPath(): string {
    return join(this.agentDir, "settings.json");
  }

  get prefsPath(): string {
    return join(this.agentDir, "pi-chat-model-prefs.json");
  }

  async read(): Promise<ModelPreferencesSnapshot> {
    const settings = await readJsonObject(this.settingsPath);
    const prefs = existsSync(this.prefsPath) ? await readJsonObject(this.prefsPath) : {};
    return {
      defaultProvider: stringField(settings.defaultProvider),
      defaultModel: stringField(settings.defaultModel),
      favorites: stringList(prefs.favorites, MAX_MODEL_FAVORITES),
      recent: stringList(prefs.recent, MAX_MODEL_RECENT),
    };
  }

  async apply(patch: {
    default?: { provider: string; id: string };
    favorite?: { provider: string; id: string; on: boolean };
    used?: { provider: string; id: string };
  }): Promise<ModelPreferencesSnapshot> {
    if (patch.default) {
      const ref = validateRef(patch.default.provider, patch.default.id);
      const settings = await readJsonObject(this.settingsPath);
      settings.defaultProvider = ref.provider;
      settings.defaultModel = ref.id;
      await writeFileAtomic(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
    if (patch.favorite || patch.used) {
      const prefs = existsSync(this.prefsPath) ? await readJsonObject(this.prefsPath) : {};
      let favorites = stringList(prefs.favorites, MAX_MODEL_FAVORITES);
      let recent = stringList(prefs.recent, MAX_MODEL_RECENT);
      if (patch.favorite) {
        const ref = validateRef(patch.favorite.provider, patch.favorite.id);
        const key = modelPreferenceKey(ref.provider, ref.id);
        favorites = patch.favorite.on
          ? [key, ...favorites.filter((item) => item !== key)].slice(0, MAX_MODEL_FAVORITES)
          : favorites.filter((item) => item !== key);
      }
      if (patch.used) {
        const ref = validateRef(patch.used.provider, patch.used.id);
        const key = modelPreferenceKey(ref.provider, ref.id);
        recent = [key, ...recent.filter((item) => item !== key)].slice(0, MAX_MODEL_RECENT);
      }
      await writeFileAtomic(this.prefsPath, `${JSON.stringify({ ...prefs, favorites, recent }, null, 2)}\n`);
    }
    return this.read();
  }
}
