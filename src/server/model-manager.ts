import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CustomModelInput, ModelInfo } from "../shared/types.js";

export const MODEL_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export type ModelApi = typeof MODEL_APIS[number];

interface ModelsFile {
  providers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validateName(value: string, label: string, pattern: RegExp, maximum: number): string {
  const result = value.trim();
  if (!result || result.length > maximum || !pattern.test(result)) throw new Error(`${label} 格式无效`);
  return result;
}

function positiveInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) throw new Error(`${label} 必须是有效正整数`);
  return number;
}

export function validateCustomModel(value: unknown): CustomModelInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型配置必须是对象");
  const input = value as Record<string, unknown>;
  const provider = validateName(String(input.provider || ""), "Provider", /^[A-Za-z0-9._-]+$/, 80);
  const id = validateName(String(input.id || ""), "Model ID", /^[^\s\u0000-\u001f]+$/, 200);
  const api = String(input.api || "openai-completions") as ModelApi;
  if (!MODEL_APIS.includes(api)) throw new Error("不支持的模型 API 类型");
  const baseUrl = nonEmptyString(input.baseUrl);
  if (baseUrl) {
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new Error("Base URL 格式无效"); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Base URL 只支持 HTTP 或 HTTPS");
  }
  const name = nonEmptyString(input.name);
  if (name && name.length > 200) throw new Error("模型名称过长");
  const apiKey = nonEmptyString(input.apiKey);
  if (apiKey && apiKey.length > 10_000) throw new Error("API Key 配置过长");
  return {
    provider,
    id,
    name,
    baseUrl,
    api,
    apiKey,
    reasoning: input.reasoning === true,
    imageInput: input.imageInput === true,
    contextWindow: positiveInteger(input.contextWindow, "Context Window", 100_000_000),
    maxTokens: positiveInteger(input.maxTokens, "Max Tokens", 10_000_000),
  };
}

export class ModelManager {
  readonly path: string;

  constructor(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) {
    this.path = join(agentDir, "models.json");
  }

  private async read(): Promise<ModelsFile> {
    if (!existsSync(this.path)) return { providers: {} };
    let value: unknown;
    try { value = JSON.parse(await readFile(this.path, "utf8")); }
    catch { throw new Error(`无法解析 ${this.path}，请先修复 JSON`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("models.json 根节点必须是对象");
    const result = value as ModelsFile;
    if (result.providers !== undefined && (!result.providers || typeof result.providers !== "object" || Array.isArray(result.providers))) throw new Error("models.json providers 必须是对象");
    return result;
  }

  private async write(value: ModelsFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.pi-chat-${process.pid}-${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }

  async customKeys(): Promise<Set<string>> {
    const value = await this.read();
    const result = new Set<string>();
    for (const [provider, config] of Object.entries(value.providers || {})) {
      const models = Array.isArray(config.models) ? config.models : [];
      for (const model of models) {
        if (model && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string") {
          result.add(`${provider}\u0000${(model as Record<string, unknown>).id}`);
        }
      }
    }
    return result;
  }

  async annotate(models: ModelInfo[]): Promise<ModelInfo[]> {
    const custom = await this.customKeys();
    return models.map((model) => ({ ...model, custom: custom.has(`${model.provider}\u0000${model.id}`) }));
  }

  async getCustomConfig(providerValue: unknown, idValue: unknown): Promise<CustomModelInput> {
    const providerName = validateName(String(providerValue || ""), "Provider", /^[A-Za-z0-9._-]+$/, 80);
    const id = validateName(String(idValue || ""), "Model ID", /^[^\s\u0000-\u001f]+$/, 200);
    const value = await this.read();
    const provider = value.providers?.[providerName];
    const model = provider && Array.isArray(provider.models)
      ? provider.models.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === id) as Record<string, unknown> | undefined
      : undefined;
    if (!provider || !model) throw new Error("只能编辑 models.json 中的自定义模型");
    const api = (typeof model.api === "string" ? model.api : typeof provider.api === "string" ? provider.api : "openai-completions") as ModelApi;
    if (!MODEL_APIS.includes(api)) throw new Error("模型 API 类型不受支持");
    const input = Array.isArray(model.input) ? model.input : [];
    return {
      provider: providerName,
      id,
      name: typeof model.name === "string" ? model.name : id,
      baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
      api,
      apiKey: "",
      reasoning: model.reasoning === true,
      imageInput: input.includes("image"),
      contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
      maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
    };
  }

  private upsert(value: ModelsFile, input: CustomModelInput, carried: { baseUrl?: string; apiKey?: string } = {}, insertAt?: number): void {
    const providers = value.providers ||= {};
    const existing = providers[input.provider];
    const provider = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    if (input.baseUrl) provider.baseUrl = input.baseUrl;
    else if (!provider.baseUrl && carried.baseUrl) provider.baseUrl = carried.baseUrl;
    if (!provider.baseUrl) throw new Error("新 Provider 必须填写 Base URL");
    const providerApi = typeof provider.api === "string" ? provider.api : undefined;
    if (!providerApi) provider.api = input.api;
    const apiKey = input.apiKey || carried.apiKey;
    if (apiKey) provider.apiKey = apiKey;
    const models = Array.isArray(provider.models) ? [...provider.models] : [];
    const previousIndex = models.findIndex((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === input.id);
    const previous = previousIndex >= 0 && models[previousIndex] && typeof models[previousIndex] === "object" ? models[previousIndex] as Record<string, unknown> : {};
    const model: Record<string, unknown> = {
      ...previous,
      id: input.id,
      name: input.name || input.id,
      reasoning: input.reasoning,
      input: input.imageInput ? ["text", "image"] : ["text"],
    };
    if (providerApi && providerApi !== input.api) model.api = input.api;
    else delete model.api;
    if (input.contextWindow) model.contextWindow = input.contextWindow;
    if (input.maxTokens) model.maxTokens = input.maxTokens;
    if (previousIndex >= 0) models[previousIndex] = model;
    else if (typeof insertAt === "number") models.splice(Math.min(insertAt, models.length), 0, model);
    else models.push(model);
    provider.models = models;
    providers[input.provider] = provider;
  }

  async add(raw: unknown): Promise<CustomModelInput> {
    const input = validateCustomModel(raw);
    const value = await this.read();
    this.upsert(value, input);
    await this.write(value);
    return input;
  }

  /**
   * Rename-aware edit: the entry is located by its original (provider, id)
   * key, then re-inserted at the new key. Provider-level baseUrl/apiKey are
   * carried across a provider rename because the form never echoes the key.
   */
  async update(originalProviderValue: unknown, originalIdValue: unknown, raw: unknown): Promise<CustomModelInput> {
    const originalProvider = validateName(String(originalProviderValue || ""), "Provider", /^[A-Za-z0-9._-]+$/, 80);
    const originalId = validateName(String(originalIdValue || ""), "Model ID", /^[^\s\u0000-\u001f]+$/, 200);
    const input = validateCustomModel(raw);
    const value = await this.read();
    const providers = value.providers ||= {};
    const sourceProvider = providers[originalProvider];
    if (!sourceProvider || !Array.isArray(sourceProvider.models)) throw new Error("只能编辑 models.json 中的自定义模型");
    const sourceIndex = sourceProvider.models.findIndex((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === originalId);
    if (sourceIndex < 0) throw new Error("只能编辑 models.json 中的自定义模型");
    if (originalProvider !== input.provider || originalId !== input.id) {
      const target = providers[input.provider];
      const targetModels = target && Array.isArray(target.models) ? target.models : [];
      if (targetModels.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === input.id)) {
        throw new Error(`models.json 中已存在 ${input.provider}/${input.id}`);
      }
    }
    const carried = {
      baseUrl: typeof sourceProvider.baseUrl === "string" ? sourceProvider.baseUrl : undefined,
      apiKey: typeof sourceProvider.apiKey === "string" ? sourceProvider.apiKey : undefined,
    };
    const remaining = sourceProvider.models.filter((_, index) => index !== sourceIndex);
    if (remaining.length) sourceProvider.models = remaining;
    else {
      delete sourceProvider.models;
      const simpleProviderKeys = new Set(["baseUrl", "api", "apiKey"]);
      if (Object.keys(sourceProvider).every((key) => simpleProviderKeys.has(key))) delete providers[originalProvider];
    }
    this.upsert(value, input, carried, originalProvider === input.provider ? sourceIndex : undefined);
    await this.write(value);
    return input;
  }

  async remove(providerValue: unknown, idValue: unknown): Promise<void> {
    const providerName = validateName(String(providerValue || ""), "Provider", /^[A-Za-z0-9._-]+$/, 80);
    const id = validateName(String(idValue || ""), "Model ID", /^[^\s\u0000-\u001f]+$/, 200);
    const value = await this.read();
    const provider = value.providers?.[providerName];
    if (!provider || !Array.isArray(provider.models)) throw new Error("只能删除 models.json 中的自定义模型");
    const next = provider.models.filter((item) => !(item && typeof item === "object" && (item as Record<string, unknown>).id === id));
    if (next.length === provider.models.length) throw new Error("只能删除 models.json 中的自定义模型");
    if (next.length) provider.models = next;
    else {
      delete provider.models;
      const simpleProviderKeys = new Set(["baseUrl", "api", "apiKey"]);
      if (value.providers && Object.keys(provider).every((key) => simpleProviderKeys.has(key))) delete value.providers[providerName];
    }
    await this.write(value);
  }
}
