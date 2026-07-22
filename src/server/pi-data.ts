import type { ModelInfo, PiMessage, PiState, PromptImage, SessionStats, SlashCommand } from "../shared/types.js";
import { rpcData } from "./rpc-client.js";

export const RECENT_TURN_WINDOW_SIZE = 20;

export function promptImages(value: unknown): PromptImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error("一次最多发送 4 张图片");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("图片数据无效");
    const image = entry as Record<string, unknown>;
    const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : "";
    const data = typeof image.data === "string" ? image.data : "";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) throw new Error("仅支持 PNG、JPEG、WebP 和 GIF 图片");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("图片 Base64 数据无效");
    const approximateBytes = Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (approximateBytes <= 0 || approximateBytes > 8 * 1024 * 1024) throw new Error("单张图片必须小于 8 MB");
    return { type: "image", data, mimeType };
  });
}

export function asState(response: Record<string, unknown>): PiState {
  return rpcData<PiState>(response);
}

export function asMessages(response: Record<string, unknown>): PiMessage[] {
  return rpcData<{ messages: PiMessage[] }>(response).messages;
}

/** Keep newest complete user-initiated turns rather than raw message entries. */
export function messageWindow(messages: PiMessage[], turnLimit = RECENT_TURN_WINDOW_SIZE): { messages: PiMessage[]; total: number; turns: number; visibleTurns: number; truncated: boolean } {
  const total = messages.length;
  const userStarts = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  const turns = userStarts.length;
  const visibleTurns = Math.min(turns, Math.max(RECENT_TURN_WINDOW_SIZE, Math.floor(turnLimit)));
  const start = turns > visibleTurns ? userStarts.at(-visibleTurns) || 0 : 0;
  return { messages: start ? messages.slice(start) : messages, total, turns, visibleTurns, truncated: start > 0 };
}

export function asModels(response: Record<string, unknown>): ModelInfo[] {
  return rpcData<{ models: ModelInfo[] }>(response).models;
}

export function asCommands(response: Record<string, unknown>): SlashCommand[] {
  return rpcData<{ commands: SlashCommand[] }>(response).commands;
}

export function asSessionStats(response: Record<string, unknown>): SessionStats {
  return rpcData<SessionStats>(response);
}
