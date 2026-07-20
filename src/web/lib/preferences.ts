export type ThemePreference = "system" | "light" | "dark";
export type FontPreference = "system" | "serif" | "mono";

export interface AppearancePreferences {
  theme: ThemePreference;
  font: FontPreference;
  fontSize: number;
  lineHeight: number;
  chatWidth: number;
  markdownCss: string;
}

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: "system",
  font: "system",
  fontSize: 16,
  lineHeight: 1.7,
  chatWidth: 980,
  markdownCss: "",
};

const STORAGE_KEY = "pi-chat.appearance.v1";
const SIDEBAR_KEY = "pi-chat.sidebar-open.v1";
const TODO_PANEL_COLLAPSED_KEY = "pi-chat.todo-panel-collapsed.v1";

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

export function loadAppearance(): AppearancePreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Partial<AppearancePreferences>;
    return {
      theme: ["system", "light", "dark"].includes(saved.theme || "") ? saved.theme as ThemePreference : DEFAULT_APPEARANCE.theme,
      font: ["system", "serif", "mono"].includes(saved.font || "") ? saved.font as FontPreference : DEFAULT_APPEARANCE.font,
      fontSize: clamp(saved.fontSize, 13, 22, DEFAULT_APPEARANCE.fontSize),
      lineHeight: clamp(saved.lineHeight, 1.35, 2.2, DEFAULT_APPEARANCE.lineHeight),
      chatWidth: clamp(saved.chatWidth, 680, 1500, DEFAULT_APPEARANCE.chatWidth),
      markdownCss: typeof saved.markdownCss === "string" ? saved.markdownCss.replace(/\u0000/g, "").slice(0, 50_000) : DEFAULT_APPEARANCE.markdownCss,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(preferences: AppearancePreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function loadSidebarOpen(): boolean {
  return localStorage.getItem(SIDEBAR_KEY) !== "false";
}

export function saveSidebarOpen(open: boolean): void {
  localStorage.setItem(SIDEBAR_KEY, String(open));
}

export function loadTodoPanelCollapsed(): boolean {
  return localStorage.getItem(TODO_PANEL_COLLAPSED_KEY) === "true";
}

export function saveTodoPanelCollapsed(collapsed: boolean): void {
  localStorage.setItem(TODO_PANEL_COLLAPSED_KEY, String(collapsed));
}

export function applyAppearance(preferences: AppearancePreferences): void {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.dataset.font = preferences.font;
  root.style.setProperty("--reading-font-size", `${preferences.fontSize}px`);
  root.style.setProperty("--reading-line-height", String(preferences.lineHeight));
  root.style.setProperty("--reading-width", `${preferences.chatWidth}px`);
  let customStyle = document.getElementById("pi-chat-markdown-css") as HTMLStyleElement | null;
  if (!customStyle) {
    customStyle = document.createElement("style");
    customStyle.id = "pi-chat-markdown-css";
    document.head.append(customStyle);
  }
  customStyle.textContent = preferences.markdownCss;
}
