import { normalizeStreamingAssistantMessage } from "../../shared/streaming-assistant";
import type { ApplicationLifecycle, PiMessage, PromptImage } from "../../shared/types";

export function parseEventData(rawEvent: Event): Record<string, unknown> {
  const data = (rawEvent as MessageEvent<string>).data || "{}";
  return JSON.parse(data) as Record<string, unknown>;
}

export function lifecycleFromEvent(event: Record<string, unknown>): ApplicationLifecycle {
  const value = event.lifecycle;
  return value === "restarting" || value === "shutting-down" || value === "workspace-changing" || value === "resources-reloading" ? value : "idle";
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
