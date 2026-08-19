import { randomUUID } from "node:crypto";

interface MessageRecord extends Record<string, unknown> {
  role?: unknown;
  toolCallId?: unknown;
}

function messageRecord(value: unknown): MessageRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as MessageRecord
    : null;
}

function lifecycleSlot(message: MessageRecord): string | null {
  if (typeof message.role !== "string" || !message.role) return null;
  if (message.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId)
    return `toolResult:${message.toolCallId}`;
  return message.role;
}

/**
 * Assigns one opaque identity to each Runtime message lifecycle without
 * trusting or mutating provider-owned fields. IDs are transient projection
 * metadata; persisted JSONL receives its own entry-derived identity.
 */
export class LiveMessageIdentityRegistry {
  private readonly activeBySession = new Map<string, Map<string, string>>();

  constructor(private readonly createId: () => string = randomUUID) {}

  project(sessionId: string, event: Record<string, unknown>): Record<string, unknown> {
    const type = event.type;
    if (type === "agent_settled" || type === "pi_chat_process_error") {
      this.activeBySession.delete(sessionId);
      return event;
    }
    if (type !== "message_start" && type !== "message_update" && type !== "message_end") return event;

    const message = messageRecord(event.message);
    const slot = message ? lifecycleSlot(message) : type === "message_update" ? "assistant" : null;
    if (!slot) return event;

    let active = this.activeBySession.get(sessionId);
    if (!active) {
      active = new Map<string, string>();
      this.activeBySession.set(sessionId, active);
    }
    let id = active.get(slot);
    if (type === "message_start" || !id) {
      id = this.createId();
      active.set(slot, id);
    }

    let projectedMessage: Record<string, unknown> | null = null;
    if (message) {
      const {
        piChatLiveMessageId: _untrustedLiveMessageId,
        piChatPersistedMessageId: _untrustedPersistedMessageId,
        ...runtimeMessage
      } = message;
      projectedMessage = { ...runtimeMessage, piChatLiveMessageId: id };
    }
    const projected = {
      ...event,
      ...(projectedMessage ? { message: projectedMessage } : null),
    };
    if (type === "message_end") {
      active.delete(slot);
      if (active.size === 0) this.activeBySession.delete(sessionId);
    }
    return projected;
  }
}
