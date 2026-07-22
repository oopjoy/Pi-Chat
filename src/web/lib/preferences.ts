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
  chatWidth: 950,
  markdownCss: "",
};

/** Snap any number onto the appearance step grid, clamped to [minimum, maximum]. */
export function snapToStep(value: unknown, minimum: number, maximum: number, step: number, fallback?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback ?? minimum;
  const clamped = Math.max(minimum, Math.min(maximum, value));
  const index = Math.round((clamped - minimum) / step);
  const decimals = String(step).split(".")[1]?.length ?? 0;
  return Number((minimum + index * step).toFixed(decimals));
}

const STORAGE_KEY = "pi-chat.appearance.v1";
const SIDEBAR_KEY = "pi-chat.sidebar-open.v1";
const SIDEBAR_WIDTH_KEY = "pi-chat.sidebar-width.v1";
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 286;

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
      fontSize: snapToStep(saved.fontSize, 10, 30, 1, DEFAULT_APPEARANCE.fontSize),
      lineHeight: snapToStep(saved.lineHeight, 1.0, 3.0, 0.1, DEFAULT_APPEARANCE.lineHeight),
      chatWidth: snapToStep(saved.chatWidth, 600, 1500, 50, DEFAULT_APPEARANCE.chatWidth),
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

export function loadSidebarWidth(): number {
  const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
  return clamp(Number(raw), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_DEFAULT);
}

export function saveSidebarWidth(width: number): void {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(clamp(width, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_DEFAULT))));
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
