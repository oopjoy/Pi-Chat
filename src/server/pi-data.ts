import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGES_ENCODED_BYTES,
  MAX_PROMPT_IMAGES_TOTAL_BYTES,
} from "../shared/rpc-contracts.js";
import type { ModelInfo, PiMessage, PiState, PromptImage, SessionStats, SlashCommand } from "../shared/types.js";
import { rpcData } from "./rpc-client.js";

export const RECENT_TURN_WINDOW_SIZE = 10;

export function promptImages(value: unknown): PromptImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PROMPT_IMAGES)
    throw new Error(`一次最多发送 ${MAX_PROMPT_IMAGES} 张图片`);
  let decodedBytes = 0;
  let encodedBytes = 0;
  const images = value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("图片数据无效");
    const image = entry as Record<string, unknown>;
    const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : "";
    const data = typeof image.data === "string" ? image.data : "";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) throw new Error("仅支持 PNG、JPEG、WebP 和 GIF 图片");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0)
      throw new Error("图片 Base64 数据无效");
    const imageBytes = Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (imageBytes <= 0 || imageBytes > MAX_PROMPT_IMAGE_BYTES)
      throw new Error("单张图片不能超过 8 MB");
    decodedBytes += imageBytes;
    if (decodedBytes > MAX_PROMPT_IMAGES_TOTAL_BYTES)
      throw new Error("图片总大小不能超过 40 MB");
    encodedBytes += Buffer.byteLength(data, "ascii");
    return { type: "image" as const, data, mimeType };
  });
  if (encodedBytes > MAX_PROMPT_IMAGES_ENCODED_BYTES)
    throw new Error("图片编码后的总量超过 RPC 安全上限");
  return images;
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
