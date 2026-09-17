import {
  decodeCanonicalMessageEndEvent,
  type CanonicalMessageEndEvent,
} from "../../shared/runtime-events";
import { normalizeStreamingAssistantMessage } from "../../shared/streaming-assistant";
import type { ApplicationLifecycle, PiMessage, PromptImage } from "../../shared/types";
import { isApplicationLifecycle } from "../application/application-lifecycle";

export function parseEventData(rawEvent: Event): Record<string, unknown> | null {
  try {
    const data = (rawEvent as MessageEvent<string>).data || "{}";
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function canonicalMessageEndFromEvent(
  event: Record<string, unknown>,
): CanonicalMessageEndEvent | null {
  return decodeCanonicalMessageEndEvent(event);
}

export function lifecycleFromEvent(
  event: Record<string, unknown>,
): ApplicationLifecycle | null {
  return isApplicationLifecycle(event.lifecycle) ? event.lifecycle : null;
}

export function assistantMessage(event: Record<string, unknown>): PiMessage | null {
  const message = event.message;
  if (!message || typeof message !== "object" || (message as PiMessage).role !== "assistant") return null;
  return normalizeStreamingAssistantMessage(message as PiMessage, event.assistantMessageEvent);
}

export function userMessage(text: string, images: PromptImage[]): PiMessage {
  if (!images.length) return { role: "user", content: text, timestamp: Date.now() };
  return {
    role: "user",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })),
    ],
    timestamp: Date.now(),
  };
}
