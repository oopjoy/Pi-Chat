import type { SlashCommand } from "../../shared/types";

function compactDescription(value: string | undefined): string {
  const clean = (value || "").replace(/\s+/g, " ").trim();
  if (!clean) return "扩展功能已触发";
  return clean.length > 72 ? `${clean.slice(0, 71)}…` : clean;
}

export function extensionExecutionNotice(message: string, commandName: string, commands: SlashCommand[]): string {
  const args = message.replace(/^\/[^\s/]+\s*/, "").trim().toLowerCase();
  if (commandName === "gate") {
    if (["open", "off", "allow", "disable"].includes(args)) return "已执行 /gate open · write/edit 和已识别的高风险 Bash 将不再要求确认";
    if (["strict", "on", "close", "closed", "enable"].includes(args)) return "已执行 /gate strict · 已恢复 write/edit 及已识别高风险 Bash 的确认提示";
    if (["once", "next"].includes(args)) return "已执行 /gate once · Gate 仅支持 strict、open 和 status";
    return "已执行 /gate status · 已显示当前文件权限模式";
  }
  const description = commands.find((item) => item.name === commandName && item.source === "extension")?.description;
  return `已执行 /${commandName}${args ? ` ${args}` : ""} · ${compactDescription(description)}`;
}
