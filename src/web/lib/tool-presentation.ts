import type { ComponentType, SVGProps } from "react";
import {
  FileIcon,
  FileSearchIcon,
  GlobeIcon,
  ImageIcon,
  MessagesIcon,
  PencilIcon,
  SearchIcon,
  SubagentsIcon,
  TerminalIcon,
  WrenchIcon,
} from "../components/Icons";

/**
 * Data-driven tool presentation (pi-inspire's tool-presentations idea,
 * right-sized): tools map to semantic families, families map to one stable
 * icon, so the activity list reads as a narrative instead of same-looking
 * rows. Extension tools join an existing family without new visual language.
 * Presentation only, never authority: families must not influence Gate,
 * approval, tool classification, or any security decision.
 */
export type ToolSemanticFamily =
  | "terminal"
  | "message"
  | "mutation"
  | "document"
  | "search"
  | "agent"
  | "network"
  | "image"
  | "generic";

export type ToolPresentation = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  family: ToolSemanticFamily;
};

const FAMILY_ICONS: Record<ToolSemanticFamily, ComponentType<SVGProps<SVGSVGElement>>> = {
  terminal: TerminalIcon,
  message: MessagesIcon,
  mutation: PencilIcon,
  document: FileIcon,
  search: SearchIcon,
  agent: SubagentsIcon,
  network: GlobeIcon,
  image: ImageIcon,
  generic: WrenchIcon,
};

/** Known tools map to a family; unknown tools (including extension tools) fall back. */
const TOOL_FAMILIES: Record<string, ToolSemanticFamily> = {
  bash: "terminal",
  powershell: "terminal",
  shell: "terminal",
  shell_exec: "terminal",
  cmd: "terminal",
  sh: "terminal",
  read: "document",
  cat: "document",
  write: "mutation",
  edit: "mutation",
  multiedit: "mutation",
  patch_file: "mutation",
  str_replace: "mutation",
  grep: "search",
  rg: "search",
  ripgrep: "search",
  find: "search",
  glob: "search",
  ls: "search",
  intercom: "message",
  send_message: "message",
  subagent: "agent",
  web_search: "network",
  antigravity_websearch: "network",
  fetch: "network",
  http_fetch: "network",
  fetch_content: "network",
  source_check: "network",
  image: "image",
};

export function toolFamily(name: string): ToolSemanticFamily {
  return TOOL_FAMILIES[name.trim().toLowerCase()] ?? "generic";
}

export function toolPresentation(name: string): ToolPresentation {
  const family = toolFamily(name);
  return { icon: FAMILY_ICONS[family], family };
}
