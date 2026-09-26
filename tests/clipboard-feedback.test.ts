import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { ChatMessage } from "../src/web/components/ChatMessage";
import { installAppDom } from "./helpers/app-dom";

function installClipboard(dom: ReturnType<typeof installAppDom>["dom"]) {
  const writes: string[] = [];
  let failing = true;
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (failing) throw new Error("NotAllowedError");
        writes.push(text);
      },
    },
  });
  return {
    writes,
    allow: () => { failing = false; },
  };
}

async function exerciseFailureThenSuccess(
  message: Parameters<typeof ChatMessage>[0]["message"],
  selector: string,
  expectedText: string,
) {
  const { dom } = installAppDom();
  const clipboard = installClipboard(dom);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ChatMessage, { message })));
    const button = dom.window.document.querySelector<HTMLButtonElement>(selector)!;
    assert.ok(button, `missing copy button ${selector}`);

    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    assert.match(button.title, /复制失败，请检查浏览器权限/);
    assert.match(button.getAttribute("aria-label") || "", /复制.*失败/);

    clipboard.allow();
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    assert.match(button.title, /已复制/);
    assert.deepEqual(clipboard.writes, [expectedText]);
  } finally {
    await act(async () => root.unmount());
  }
}

test("Assistant answer Copy exposes permission failure and recovery", async () => {
  await exerciseFailureThenSuccess(
    { role: "assistant", content: "answer text" },
    ".message-footer button",
    "answer text",
  );
});

test("User message Copy exposes permission failure and recovery", async () => {
  await exerciseFailureThenSuccess(
    { role: "user", content: "user text" },
    ".message-user-actions button",
    "user text",
  );
});

test("fenced code Copy exposes permission failure and recovery", async () => {
  await exerciseFailureThenSuccess(
    { role: "assistant", content: "```ts\nconst value = 1;\n```" },
    ".code-head button",
    "const value = 1;",
  );
});
