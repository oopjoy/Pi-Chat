import type { SlashCommand } from "../../shared/types";

function compactDescription(value: string | undefined): string {
  const clean = (value || "").replace(/\s+/g, " ").trim();
  if (!clean) return "扩展功能已触发";
  return clean.length > 72 ? `${clean.slice(0, 71)}…` : clean;
}

export function extensionExecutionNotice(message: string, commandName: string, commands: SlashCommand[]): string {
  const args = message.replace(/^\/[^\s/]+\s*/, "").trim().toLowerCase();
  if (commandName === "gate") {
    if (["open", "off", "allow", "disable"].includes(args)) return "已执行 /gate open · 文件写入、编辑和破坏性 Bash 将不再要求确认";
    if (["strict", "on", "close", "closed", "enable"].includes(args)) return "已执行 /gate strict · 已恢复文件写入、编辑和破坏性 Bash 的确认提示";
    if (["once", "next"].includes(args)) return "已执行 /gate once · 下一次受保护操作将直接允许，随后恢复确认";
    return "已执行 /gate status · 已显示当前文件权限模式";
  }
  const description = commands.find((item) => item.name === commandName && item.source === "extension")?.description;
  return `已执行 /${commandName}${args ? ` ${args}` : ""} · ${compactDescription(description)}`;
}
