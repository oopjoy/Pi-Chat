import type { ModelInfo } from "../../shared/types";

export function modelPreferenceKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

export type ModelPreferencesSnapshot = {
  defaultProvider: string;
  defaultModel: string;
  favorites: string[];
  recent: string[];
};

export const EMPTY_MODEL_PREFERENCES: ModelPreferencesSnapshot = {
  defaultProvider: "",
  defaultModel: "",
  favorites: [],
  recent: [],
};

export type ComposerModelSection = {
  id: "current" | "favorites" | "recent" | "all";
  label: string;
  models: ModelInfo[];
};

export function composerModelSections(
  models: ModelInfo[],
  current: ModelInfo | null,
  favorites: string[],
  recent: string[],
): ComposerModelSection[] {
  const keyOf = (model: ModelInfo) => modelPreferenceKey(model.provider, model.id);
  const used = new Set<string>();
  const take = (keys: string[]) => {
    const list: ModelInfo[] = [];
    for (const key of keys) {
      const model = models.find((item) => keyOf(item) === key);
      if (!model || used.has(keyOf(model))) continue;
      used.add(keyOf(model));
      list.push(model);
    }
    return list;
  };
  const sections: ComposerModelSection[] = [];
  if (current) {
    sections.push({ id: "current", label: "当前会话", models: [current] });
    used.add(keyOf(current));
  }
  const favoriteModels = take(favorites);
  if (favoriteModels.length) sections.push({ id: "favorites", label: "常用", models: favoriteModels });
  const recentModels = take(recent);
  if (recentModels.length) sections.push({ id: "recent", label: "最近", models: recentModels });
  const rest = models.filter((model) => !used.has(keyOf(model)));
  if (rest.length) sections.push({ id: "all", label: "全部模型", models: rest });
  return sections;
}
