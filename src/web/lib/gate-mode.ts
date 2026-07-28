import type { GateMode } from "../../shared/types";

export type { GateMode };

export function gateModeFromCommand(message: string): GateMode | null {
  const command = /^\/gate\s+([^\s]+)\s*$/i.exec(message.trim())?.[1]?.toLowerCase();
  if (["strict", "on", "close", "closed", "enable"].includes(command || "")) return "strict";
  if (["open", "off", "allow", "disable"].includes(command || "")) return "open";
  return null;
}

/** Parses mode notifications emitted by pi-chat-file-permission-gate.ts. */
export function gateModeFromNotice(message: string | undefined): GateMode | null {
  const value = message || "";
  const match = /^Gate mode:\s*(strict|open)\b/im.exec(value);
  if (match) return match[1] as GateMode;
  // Older adapters used free-form English text without a machine-readable line.
  if (/Gate opened for this Pi runtime/i.test(value)) return "open";
  if (/Gate strict mode enabled/i.test(value)) return "strict";
  return null;
}

export function gateLabel(mode: GateMode): string {
  return mode === "strict" ? "严格" : "放行";
}
