import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import type { GateMode, InitialPromptRequest, PromptImage } from "../../shared/types.js";
import { promptImages } from "../pi-data.js";
import { CLIENT_PROMPT_OPERATION_ID_PATTERN, THINKING_LEVELS } from "./request-validation.js";

export type NewSessionInput =
  | { kind: "error"; status: 400; error: string }
  | {
      kind: "valid";
      cwd: string;
      initial: InitialPromptRequest | null;
      message: string;
      images: PromptImage[];
      gateMode?: GateMode;
      clientPromptOperationId: string;
    };

/** Validate the entire first-turn payload before allocating a draft Runtime. */
export async function parseNewSessionInput(
  body: Record<string, unknown>,
  currentCwd: string,
): Promise<NewSessionInput> {
  const cwd = typeof body.cwd === "string" && body.cwd.trim()
    ? resolve(body.cwd)
    : currentCwd;
  if (!(await stat(cwd)).isDirectory())
    return { kind: "error", status: 400, error: "新对话工作目录不存在或不是文件夹" };
  const initial = body.initial && typeof body.initial === "object" && !Array.isArray(body.initial)
    ? body.initial as InitialPromptRequest
    : null;
  const message = typeof initial?.message === "string" ? initial.message.trim() : "";
  const images = initial ? promptImages(initial.images) : [];
  const gateMode = initial?.gateMode === "strict" || initial?.gateMode === "open"
    ? initial.gateMode
    : undefined;
  if (initial?.gateMode !== undefined && !gateMode)
    return { kind: "error", status: 400, error: "无效的 Gate 模式" };
  const clientPromptOperationId = typeof initial?.clientPromptOperationId === "string"
    ? initial.clientPromptOperationId
    : "";
  if (initial?.clientPromptOperationId !== undefined
    && !CLIENT_PROMPT_OPERATION_ID_PATTERN.test(clientPromptOperationId))
    return { kind: "error", status: 400, error: "Prompt 操作标识无效" };
  if (initial?.thinkingLevel !== undefined
    && !THINKING_LEVELS.includes(initial.thinkingLevel))
    return { kind: "error", status: 400, error: "无效的 Thinking 强度" };
  if (initial?.model !== undefined && (
    !initial.model
    || typeof initial.model.provider !== "string"
    || !initial.model.provider
    || typeof initial.model.modelId !== "string"
    || !initial.model.modelId
    || (initial.model.api !== undefined
      && (typeof initial.model.api !== "string" || !initial.model.api))
  )) return { kind: "error", status: 400, error: "新对话模型配置无效" };
  if (initial && !message && !images.length)
    return { kind: "error", status: 400, error: "消息或图片不能为空" };
  return { kind: "valid", cwd, initial, message, images, gateMode, clientPromptOperationId };
}
