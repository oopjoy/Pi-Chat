import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

async function openSession(page: Page) {
  await page.goto("/");
  await expect(page.getByText("First answer", { exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: "消息输入" });
  await expect(input).toBeEnabled();
  return input;
}

async function restore(page: Page) {
  const recover = page.locator(".composer-recovery").getByRole("button", { name: "恢复草稿", exact: true }).first();
  await expect(recover).toBeVisible();
  await recover.click();
}

test("reload recovers text and an IndexedDB image without overwriting new input or sending", { tag: "@desktop-only" }, async ({ page }) => {
  const input = await openSession(page);
  let sends = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/chat/prompt")) sends += 1; });
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 2;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({ name: "plot.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.locator(".composer-attachment.is-image")).toHaveCount(1);
  await input.fill("unsent scientific question before reload");
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const opening = indexedDB.open("pi-chat-draft-recovery-v1");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const query = db.transaction("images", "readonly").objectStore("images").count();
      query.onsuccess = () => { resolve(query.result); db.close(); };
      query.onerror = () => { reject(query.error); db.close(); };
    };
  }))).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  await page.reload();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("");
  await input.fill("new typing after reload");
  await restore(page);
  await expect(input).toHaveValue("new typing after reload");
  await page.getByRole("button", { name: "恢复下一份草稿", exact: true }).click();
  await expect(input).toHaveValue("unsent scientific question before reload");
  await expect(page.locator(".composer-attachment.is-image img")).toHaveAttribute("alt", "plot.png");
  expect(sends).toBe(0);
});

test("TopBar conversation actions mirror the Sidebar menu and copy the verified session file", { tag: "@desktop-only" }, async ({ page }) => {
  await openSession(page);
  const trigger = page.locator(".topbar-session-actions-trigger");
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.locator(".topbar-session-actions-menu");
  await expect(menu).toBeVisible();
  const entries = menu.locator("button");
  await expect(entries).toHaveCount(5);
  await expect(entries.nth(0)).toHaveText("置顶");
  await expect(entries.nth(1)).toHaveText("复制为新对话");
  await expect(entries.nth(2)).toHaveText("复制对话源路径");
  await expect(entries.nth(3)).toHaveText("重命名");
  await expect(entries.nth(4)).toHaveText("删除");
  let jsonl = "";
  const response = page.waitForResponse((r) => r.url().endsWith("/session-file"));
  await entries.nth(2).click();
  const result = await response;
  expect(result.status()).toBe(200);
  jsonl = (await result.json() as { sessionFile: string }).sessionFile;
  expect(jsonl).toMatch(/first\.jsonl$/);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(jsonl);
  await page.locator(".app-toast").waitFor();
});

test("closing an editor window leaves an explicitly recoverable draft for a new window", { tag: "@desktop-only" }, async ({ page, context }) => {
  const editor = await context.newPage();
  const input = await openSession(editor);
  await input.fill("draft from the closed window");
  await editor.close();
  const replacement = await openSession(page);
  let sends = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/chat/prompt")) sends += 1; });
  await restore(page);
  await expect(replacement).toHaveValue("draft from the closed window");
  expect(sends).toBe(0);
});

test("a staged file survives reload, is retained before send and is not resurrected as a draft", { tag: "@desktop-only" }, async ({ page }) => {
  const input = await openSession(page);
  await input.fill("read my durable experiment log");
  const upload = page.waitForResponse((response) => response.url().endsWith("/api/local-files/stage"));
  const data = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["iteration 1 converged"], "experiment.log", { type: "text/plain" }));
    return transfer;
  });
  await page.locator(".composer").dispatchEvent("drop", { dataTransfer: data });
  const response = await upload;
  expect(response.status()).toBe(200);
  const { path } = await response.json() as { path: string };
  expect(path).toContain("attachments");
  expect(path).not.toContain("pi-chat-dropped");
  await expect(page.locator(".composer-attachment.is-file")).toHaveCount(1);
  await page.reload();
  await restore(page);
  await expect(input).toHaveValue("read my durable experiment log");
  await expect(page.locator(".composer-attachment.is-file .composer-attachment-face")).toHaveAttribute("title", path);
  const order: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/local-files/prepare")) order.push("retain");
    if (request.url().endsWith("/api/chat/prompt")) order.push("send");
  });
  await page.locator(".send-button").click();
  await expect(page.getByText("Live response complete")).toBeVisible();
  expect(order).toEqual(["retain", "send"]);
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  await page.getByRole("button", { name: "关于", exact: true }).click();
  const storage = page.getByRole("region", { name: "草稿与附件保存" });
  await storage.getByRole("button", { name: "查看保存情况", exact: true }).click();
  await expect(storage).toContainText("1 个已保留文件");
  await storage.getByRole("button", { name: "清理过期待发附件", exact: true }).click();
  await expect(storage).toContainText("已清理 0 个过期待发附件");
  await page.locator("#pi-chat-settings-dialog .panel-close").click();
  await page.reload();
  await expect(input).toHaveValue("");
  await expect(page.locator(".composer-recovery")).toHaveCount(0);
  await data.dispose();
});
