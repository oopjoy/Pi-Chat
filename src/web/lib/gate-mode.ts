export type GateMode = "strict" | "once" | "open";

export function gateModeFromCommand(message: string): GateMode | null {
  const command = /^\/gate\s+([^\s]+)/i.exec(message.trim())?.[1]?.toLowerCase();
  if (["strict", "on", "close", "closed", "enable"].includes(command || "")) return "strict";
  if (["once", "next"].includes(command || "")) return "once";
  if (["open", "off", "allow", "disable"].includes(command || "")) return "open";
  return null;
}

/** Parses the exact status notification emitted by file-permission-gate.ts. */
export function gateModeFromNotice(message: string | undefined): GateMode | null {
  const value = message || "";
  const match = /^Gate mode:\s*(strict|once|open)\b/im.exec(value);
  if (match) return match[1] as GateMode;
  // The bundled Gate emits this after consuming a one-shot allowance.
  if (/Gate one-shot allow used/i.test(value)) return "strict";
  return null;
}

export function gateLabel(mode: GateMode): string {
  return mode === "strict" ? "严格" : mode === "once" ? "仅一次" : "放行";
}
