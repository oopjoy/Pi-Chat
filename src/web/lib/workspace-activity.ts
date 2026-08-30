import type { PiMessage } from "../../shared/types";

/** Return the bounded activity tokens used by the workspace file-change view. */
export function workspaceFileActivityParts(messages: PiMessage[]): string[] {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId)
      parts.push(`result:${message.toolCallId}:${message.isError === true ? "error" : "ok"}`);
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const name = block.name?.toLowerCase();
      if (block.type === "toolCall" && block.id && (name === "edit" || name === "write"))
        parts.push(`call:${block.id}`);
    }
  }
  return parts;
}

/** Compose persisted and live activity without rescanning persisted history. */
export function workspaceFileActivityRevisionFromParts(
  persistedParts: string[],
  liveParts: string[] = [],
): string {
  return [...persistedParts, ...liveParts].slice(-100).join("|");
}

export function workspaceFileActivityRevision(messages: PiMessage[]): string {
  return workspaceFileActivityRevisionFromParts(workspaceFileActivityParts(messages));
}
