import { orderedPinnedDirectoryKeys, orderedPinnedSessionIds } from "./session-navigation";

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

export interface SessionNavigationPreferences {
  version: 2;
  pinnedSessionIds: string[];
  pinnedDirectoryKeys: string[];
  collapsedDirectoryKeys: string[];
  expandedDirectoryKeys: string[];
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
const SESSION_NAVIGATION_V1_KEY = "pi-chat.session-navigation.v1";
const SESSION_NAVIGATION_KEY = "pi-chat.session-navigation.v2";
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
      chatWidth: snapToStep(saved.chatWidth, 600, 1200, 50, DEFAULT_APPEARANCE.chatWidth),
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

const EMPTY_SESSION_NAVIGATION: SessionNavigationPreferences = {
  version: 2,
  pinnedSessionIds: [],
  pinnedDirectoryKeys: [],
  collapsedDirectoryKeys: [],
  expandedDirectoryKeys: [],
};

export function loadSessionNavigationPreferences(): SessionNavigationPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_NAVIGATION_KEY) || "null") as Partial<SessionNavigationPreferences> | null;
    if (saved && saved.version === 2) return {
      version: 2,
      pinnedSessionIds: orderedPinnedSessionIds(saved.pinnedSessionIds),
      pinnedDirectoryKeys: orderedPinnedDirectoryKeys(saved.pinnedDirectoryKeys),
      collapsedDirectoryKeys: orderedPinnedDirectoryKeys(saved.collapsedDirectoryKeys),
      expandedDirectoryKeys: orderedPinnedDirectoryKeys(saved.expandedDirectoryKeys),
    };
  } catch {
    // A damaged v2 record must not discard a still-readable v1 Session pin list.
  }
  try {
    const legacy = JSON.parse(localStorage.getItem(SESSION_NAVIGATION_V1_KEY) || "{}") as { pinnedSessionIds?: unknown };
    return { ...EMPTY_SESSION_NAVIGATION, pinnedSessionIds: orderedPinnedSessionIds(legacy.pinnedSessionIds) };
  } catch {
    return EMPTY_SESSION_NAVIGATION;
  }
}

export function saveSessionNavigationPreferences(preferences: SessionNavigationPreferences): void {
  localStorage.setItem(SESSION_NAVIGATION_KEY, JSON.stringify({
    version: 2,
    pinnedSessionIds: orderedPinnedSessionIds(preferences.pinnedSessionIds),
    pinnedDirectoryKeys: orderedPinnedDirectoryKeys(preferences.pinnedDirectoryKeys),
    collapsedDirectoryKeys: orderedPinnedDirectoryKeys(preferences.collapsedDirectoryKeys),
    expandedDirectoryKeys: orderedPinnedDirectoryKeys(preferences.expandedDirectoryKeys),
  }));
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
