import { MODEL_APIS, type ModelApi } from "./model-manager.js";

export interface DiscoveredProviderModel {
  id: string;
  ownedBy?: string;
}

const PROBE_TIMEOUT_MS = 12_000;
const PROBE_MAX_BYTES = 512 * 1024;
const PROBE_MAX_MODELS = 500;
const ERROR_BODY_MAX = 240;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

export function validateProbeBaseUrl(value: unknown): string {
  const baseUrl = nonEmptyString(value);
  if (!baseUrl) throw new Error("请先填写 API 地址");
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error("API 地址格式无效"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("API 地址只支持 HTTP 或 HTTPS");
  return baseUrl.replace(/\/+$/, "");
}

export function modelsUrlCandidates(baseUrl: string, api: string): string[] {
  const base = validateProbeBaseUrl(baseUrl);
  const urls: string[] = [];
  const add = (next: string) => { if (!urls.includes(next)) urls.push(next); };
  if (api === "google-generative-ai") {
    const root = base.replace(/\/v1beta$/i, "").replace(/\/v1$/i, "");
    add(`${root}/v1beta/models`);
    return urls;
  }
  if (/\/models$/i.test(base)) add(base);
  else if (/\/v\d+[a-z]*$/i.test(base)) add(`${base}/models`);
  else {
    add(`${base}/v1/models`);
    add(`${base}/models`);
  }
  return urls;
}

function modelIdFromEntry(entry: unknown): DiscoveredProviderModel | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  const raw = nonEmptyString(record.id)
    || nonEmptyString(record.slug)
    || nonEmptyString(record.name)?.replace(/^models\//, "");
  if (!raw || raw.length > 200) return undefined;
  const ownedBy = nonEmptyString(record.owned_by) || nonEmptyString(record.ownedBy);
  return ownedBy ? { id: raw, ownedBy } : { id: raw };
}

export function parseProviderModelList(payload: unknown): DiscoveredProviderModel[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("上游返回的模型列表格式无法解析");
  const record = payload as Record<string, unknown>;
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!rows) throw new Error("上游返回的模型列表格式无法解析");
  const seen = new Set<string>();
  const models: DiscoveredProviderModel[] = [];
  for (const row of rows) {
    const model = modelIdFromEntry(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
    if (models.length >= PROBE_MAX_MODELS) break;
  }
  if (!models.length) throw new Error("上游没有返回可用模型");
  return models;
}

function probeHeaders(api: string, apiKey: string): Record<string, string> {
  if (api === "anthropic-messages") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      accept: "application/json",
    };
  }
  if (api === "google-generative-ai") {
    return { "x-goog-api-key": apiKey, accept: "application/json" };
  }
  return { authorization: `Bearer ${apiKey}`, accept: "application/json" };
}

async function readLimitedJson(response: Response, secret: string): Promise<unknown> {
  const length = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > PROBE_MAX_BYTES)
    throw new Error("上游模型列表过大，已中止读取");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("上游没有返回模型列表");
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > PROBE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("上游模型列表过大，已中止读取");
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  if (!response.ok) {
    const snippet = redact(text.replace(/\s+/g, " ").trim(), secret).slice(0, ERROR_BODY_MAX);
    if (response.status === 401 || response.status === 403)
      throw new Error("上游认证失败，请检查 API 密钥");
    if (response.status === 404 || response.status === 405)
      throw new Error("该供应商未提供模型列表端点，请手动填写模型 ID");
    throw new Error(snippet ? `上游返回 HTTP ${response.status}：${snippet}` : `上游返回 HTTP ${response.status}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error("上游返回的模型列表不是有效 JSON"); }
}

export async function probeProviderModels(input: {
  baseUrl: string;
  api: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<DiscoveredProviderModel[]> {
  if (!(MODEL_APIS as readonly string[]).includes(input.api)) throw new Error("不支持的模型 API 类型");
  const apiKey = nonEmptyString(input.apiKey);
  if (!apiKey) throw new Error("请先填写 API 密钥");
  if (apiKey.length > 10_000) throw new Error("API Key 配置过长");
  const api = input.api as ModelApi;
  const urls = modelsUrlCandidates(input.baseUrl, api);
  const fetchImpl = input.fetchImpl || fetch;
  const headers = probeHeaders(api, apiKey);
  let lastError = "无法连接上游模型列表";
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      return parseProviderModelList(await readLimitedJson(response, apiKey));
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? "获取模型列表超时，请稍后重试"
        : error instanceof Error ? redact(error.message, apiKey) : lastError;
      lastError = message;
      const retryNext = /未提供模型列表端点/.test(message) || /HTTP 404|HTTP 405/.test(message);
      if (!retryNext) throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError);
}
