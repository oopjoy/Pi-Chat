import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { applyAppearance, DEFAULT_APPEARANCE, loadAppearance, loadSessionNavigationPreferences, loadSidebarOpen, loadSidebarWidth, saveAppearance, saveSessionNavigationPreferences, saveSidebarOpen, saveSidebarWidth, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, snapToStep } from "../src/web/lib/preferences";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
  return dom;
}

test("appearance preferences persist and apply CSS variables", () => {
  installDom();
  const preferences = { theme: "dark" as const, font: "mono" as const, fontSize: 18, lineHeight: 1.8, chatWidth: 1000, markdownCss: ".test { color: red; }" };
  saveAppearance(preferences);
  assert.deepEqual(loadAppearance(), preferences);
  applyAppearance(preferences);
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(document.documentElement.dataset.font, "mono");
  assert.equal(document.documentElement.style.getPropertyValue("--reading-font-size"), "18px");
  assert.equal(document.getElementById("pi-chat-markdown-css")?.textContent, preferences.markdownCss);
});

test("step snapping corrects off-grid numbers to the nearest step", () => {
  assert.equal(snapToStep(1.26, 1, 3, 0.1), 1.3);
  assert.equal(snapToStep(9, 10, 30, 1, 16), 10);
  assert.equal(snapToStep("bad", 10, 30, 1, 16), 16);
});

test("default appearance is an independent reset-safe value", () => {
  installDom();
  assert.deepEqual(loadAppearance(), DEFAULT_APPEARANCE);
});

test("invalid preferences fall back safely and sidebar state persists", () => {
  installDom();
  localStorage.setItem("pi-chat.appearance.v1", "not json");
  assert.deepEqual(loadAppearance(), DEFAULT_APPEARANCE);
  assert.equal(loadSidebarOpen(), true);
  saveSidebarOpen(false);
  assert.equal(loadSidebarOpen(), false);
});

test("sidebar width persists and clamps to the allowed range", () => {
  installDom();
  assert.equal(loadSidebarWidth(), SIDEBAR_WIDTH_DEFAULT);
  saveSidebarWidth(360);
  assert.equal(loadSidebarWidth(), 360);
  saveSidebarWidth(40);
  assert.equal(loadSidebarWidth(), SIDEBAR_WIDTH_MIN);
  saveSidebarWidth(4000);
  assert.equal(loadSidebarWidth(), SIDEBAR_WIDTH_MAX);
  localStorage.setItem("pi-chat.sidebar-width.v1", "not-a-number");
  assert.equal(loadSidebarWidth(), SIDEBAR_WIDTH_DEFAULT);
});

test("session navigation v2 migrates v1 pins and sanitizes directory preferences", () => {
  installDom();
  const empty = { version: 2 as const, pinnedSessionIds: [], pinnedDirectoryKeys: [], collapsedDirectoryKeys: [], expandedDirectoryKeys: [] };
  assert.deepEqual(loadSessionNavigationPreferences(), empty);
  localStorage.setItem("pi-chat.session-navigation.v1", JSON.stringify({ pinnedSessionIds: ["session-b", "session-a"] }));
  assert.deepEqual(loadSessionNavigationPreferences(), { ...empty, pinnedSessionIds: ["session-b", "session-a"] });
  saveSessionNavigationPreferences({ version: 2, pinnedSessionIds: ["a"], pinnedDirectoryKeys: ["C:\\Work\\", "c:/work", ""], collapsedDirectoryKeys: ["D:/Archive/"], expandedDirectoryKeys: ["E:/Open/"] });
  assert.deepEqual(loadSessionNavigationPreferences(), { version: 2, pinnedSessionIds: ["a"], pinnedDirectoryKeys: ["c:/work"], collapsedDirectoryKeys: ["d:/archive"], expandedDirectoryKeys: ["e:/open"] });
  assert.equal(localStorage.getItem("pi-chat.session-navigation.v1"), JSON.stringify({ pinnedSessionIds: ["session-b", "session-a"] }));
  localStorage.setItem("pi-chat.session-navigation.v2", "{");
  assert.deepEqual(loadSessionNavigationPreferences(), { ...empty, pinnedSessionIds: ["session-b", "session-a"] });
});
