import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { applyAppearance, DEFAULT_APPEARANCE, loadAppearance, loadSidebarOpen, loadSidebarWidth, saveAppearance, saveSidebarOpen, saveSidebarWidth, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "../src/web/lib/preferences";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1" });
  Object.assign(globalThis, {
    document: dom.window.document,
    localStorage: dom.window.localStorage,
  });
  return dom;
}

test("appearance preferences persist and apply CSS variables", () => {
  const dom = installDom();
  const value = { theme: "dark" as const, font: "serif" as const, fontSize: 18, lineHeight: 1.9, chatWidth: 1200, markdownCss: "h1 { color: red; }" };
  saveAppearance(value);
  assert.deepEqual(loadAppearance(), value);
  applyAppearance(value);
  assert.equal(dom.window.document.documentElement.dataset.theme, "dark");
  assert.equal(dom.window.document.documentElement.dataset.font, "serif");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--reading-font-size"), "18px");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--reading-line-height"), "1.9");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--reading-width"), "1200px");
  const customStyle = dom.window.document.getElementById("pi-chat-markdown-css") as HTMLStyleElement;
  assert.equal(customStyle.textContent, "h1 { color: red; }");
});

test("default appearance is an independent reset-safe value", () => {
  const reset = { ...DEFAULT_APPEARANCE };
  reset.markdownCss = ".markdown-body { color: red; }";
  assert.equal(DEFAULT_APPEARANCE.markdownCss, "");
});

test("invalid preferences fall back safely and sidebar state persists", () => {
  installDom();
  localStorage.setItem("pi-chat.appearance.v1", JSON.stringify({ theme: "invalid", fontSize: 999, lineHeight: 0, chatWidth: 10, markdownCss: 123 }));
  const loaded = loadAppearance();
  assert.equal(loaded.theme, DEFAULT_APPEARANCE.theme);
  assert.equal(loaded.fontSize, 22);
  assert.equal(loaded.lineHeight, 1.35);
  assert.equal(loaded.chatWidth, 680);
  assert.equal(loaded.markdownCss, "");
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
