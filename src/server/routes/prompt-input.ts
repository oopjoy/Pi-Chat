import type {
  GateMode,
  InitialPromptRequest,
  PromptDelivery,
  PromptImage,
  PromptSettingsSnapshot,
} from "../../shared/types.js";
import { promptImages } from "../pi-data.js";
import {
  CLIENT_PROMPT_OPERATION_ID_PATTERN,
  promptSettingsSnapshot,
  requiredSessionId,
} from "./request-validation.js";
import { HttpRequestError } from "../http-transport.js";

export interface PromptRouteInput {
  message: string;
  sessionId: string;
  gateMode?: GateMode;
  settings?: PromptSettingsSnapshot;
  delivery: PromptDelivery;
  steerId: string;
  clientPromptOperationId: string;
  images: PromptImage[];
}

export function parsePromptRouteInput(body: Record<string, unknown>): PromptRouteInput {
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const sessionId = requiredSessionId(body);
  const gateMode: GateMode | undefined =
    body.gateMode === "strict" || body.gateMode === "open" ? body.gateMode : undefined;
  const settings = promptSettingsSnapshot(body);
  if (body.delivery !== undefined && body.delivery !== "queue" && body.delivery !== "steer")
    throw new HttpRequestError(400, "消息交付方式无效");
  const delivery: PromptDelivery = body.delivery === "steer" ? "steer" : "queue";
  const steerId = typeof body.steerId === "string" ? body.steerId : "";
  const clientPromptOperationId = typeof body.clientPromptOperationId === "string"
    ? body.clientPromptOperationId
    : "";
  if (
    body.clientPromptOperationId !== undefined
    && !CLIENT_PROMPT_OPERATION_ID_PATTERN.test(clientPromptOperationId)
  ) throw new HttpRequestError(400, "Prompt 操作标识无效");
  if (
    body.steerId !== undefined
    && (delivery !== "steer" || !/^[a-f0-9-]{36}$/i.test(steerId))
  ) throw new HttpRequestError(400, "Steer 标识无效");
  const images = promptImages(body.images);
  if (!message && !images.length)
    throw new HttpRequestError(400, "消息或图片不能为空");
  return { message, sessionId, gateMode, settings, delivery, steerId, clientPromptOperationId, images };
}

export type { InitialPromptRequest };
