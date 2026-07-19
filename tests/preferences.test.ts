import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { applyAppearance, DEFAULT_APPEARANCE, loadAppearance, loadSidebarOpen, saveAppearance, saveSidebarOpen } from "../src/web/lib/preferences";

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
  const value = { theme: "dark" as const, font: "serif" as const, fontSize: 18, lineHeight: 1.9, chatWidth: 1200 };
  saveAppearance(value);
  assert.deepEqual(loadAppearance(), value);
  applyAppearance(value);
  assert.equal(dom.window.document.documentElement.dataset.theme, "dark");
  assert.equal(dom.window.document.documentElement.dataset.font, "serif");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--reading-font-size"), "18px");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--reading-line-height"), "1.9");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--reading-width"), "1200px");
});

test("invalid preferences fall back safely and sidebar state persists", () => {
  installDom();
  localStorage.setItem("pi-chat.appearance.v1", JSON.stringify({ theme: "invalid", fontSize: 999, lineHeight: 0, chatWidth: 10 }));
  const loaded = loadAppearance();
  assert.equal(loaded.theme, DEFAULT_APPEARANCE.theme);
  assert.equal(loaded.fontSize, 22);
  assert.equal(loaded.lineHeight, 1.35);
  assert.equal(loaded.chatWidth, 680);
  assert.equal(loadSidebarOpen(), true);
  saveSidebarOpen(false);
  assert.equal(loadSidebarOpen(), false);
});
