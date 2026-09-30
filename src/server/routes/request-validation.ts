import type { PromptSettingsSnapshot, ThinkingLevel } from "../../shared/types.js";
import { HttpRequestError } from "../http-transport.js";

export const SESSION_ID_PATTERN = /^[a-f0-9]{20}$/;
export const CLIENT_PROMPT_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Existing-session mutations must never infer a mutable Primary target. */
export function requiredSessionId(body: Record<string, unknown>): string {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!SESSION_ID_PATTERN.test(sessionId))
    throw new HttpRequestError(400, "sessionId 必须是有效的会话标识");
  return sessionId;
}

/** Parse the immutable next-turn selection attached to one ordinary prompt. */
export function promptSettingsSnapshot(
  body: Record<string, unknown>,
): PromptSettingsSnapshot | undefined {
  if (body.settings === undefined) return undefined;
  if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings))
    throw new HttpRequestError(400, "消息设置格式无效");
  const raw = body.settings as Record<string, unknown>;
  const rawModel = raw.model;
  let model: PromptSettingsSnapshot["model"];
  if (rawModel !== undefined) {
    if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel))
      throw new HttpRequestError(400, "模型设置格式无效");
    const candidate = rawModel as Record<string, unknown>;
    const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
    const modelId = typeof candidate.modelId === "string" ? candidate.modelId.trim() : "";
    const api = typeof candidate.api === "string" ? candidate.api.trim() : "";
    if (
      !provider || !modelId || provider.length > 80 || modelId.length > 200 || api.length > 120
      || /[\u0000-\u001f]/.test(provider)
      || /[\u0000-\u001f]/.test(modelId)
      || /[\u0000-\u001f]/.test(api)
    ) throw new HttpRequestError(400, "模型设置无效");
    model = { provider, modelId, ...(api ? { api } : null) };
  }
  const thinkingLevel = typeof raw.thinkingLevel === "string"
    && THINKING_LEVELS.includes(raw.thinkingLevel as ThinkingLevel)
    ? raw.thinkingLevel as ThinkingLevel
    : undefined;
  if (raw.thinkingLevel !== undefined && !thinkingLevel)
    throw new HttpRequestError(400, "无效的 Thinking 强度");
  if (!model && !thinkingLevel)
    throw new HttpRequestError(400, "消息设置不能为空");
  return {
    ...(model ? { model } : null),
    ...(thinkingLevel ? { thinkingLevel } : null),
  };
}
