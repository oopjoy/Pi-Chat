import { expect, test } from "@playwright/test";

async function openSecondSession(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator(".session-item", { hasText: "Second session" })).toBeVisible();
  await page.locator(".session-item", { hasText: "Second session" }).click();
  await expect(page.getByText("Final answer with")).toBeVisible();
}

test("desktop session navigation keeps the left sidebar open", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toHaveClass(/is-open/);
  await page.locator(".session-item", { hasText: "Second session" }).click();
  await expect(page.getByText("Final answer with")).toBeVisible();
  await expect(sidebar).toHaveClass(/is-open/);
});

test("mobile session navigation closes the left sidebar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-mobile");
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toHaveClass(/is-open/);
  await page.locator(".session-item", { hasText: "Second session" }).click();
  await expect(page.getByText("Final answer with")).toBeVisible();
  await expect(sidebar).not.toHaveClass(/is-open/);
});

test("an idle hot Secondary can be released without losing the open history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await openSecondSession(page);
  await page.getByRole("textbox", { name: "消息输入" }).fill("warm this session");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText("warm this session")).toBeVisible();
  const row = page.locator(".session-row", { hasText: "Second session" });
  await expect(row.locator(".session-status")).toHaveAttribute("aria-label", "已就绪");
  await row.hover();
  await row.getByRole("button", { name: "Second session 的操作菜单" }).click();
  await page.getByRole("menuitem", { name: "释放运行资源" }).click();
  await expect(page.getByText("已释放对话运行资源")).toBeVisible();
  await expect(page.getByText("Final answer with")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
  await expect(row.locator(".session-status")).toHaveAttribute("aria-label", "按需启动");
  await row.hover();
  await row.getByRole("button", { name: "Second session 的操作菜单" }).click();
  await expect(page.getByRole("menuitem", { name: "释放运行资源" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const primaryRow = page.locator(".session-row", { hasText: "First session" });
  await primaryRow.hover();
  await primaryRow.getByRole("button", { name: "First session 的操作菜单" }).click();
  await expect(page.getByRole("menuitem", { name: "释放运行资源" })).toHaveCount(0);
});

test("Diff sidebar slides, remains inert while hidden, and process collapses from the footer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await openSecondSession(page);
  const process = page.locator(".conversation-process");
  await process.locator(":scope > summary").click();
  await expect(process).toHaveAttribute("open", "");
  await process.locator(".process-edit-entry button").click();
  const diff = page.locator(".edit-diff-sidebar");
  await expect(diff).toHaveClass(/is-open/);
  await expect(diff).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(diff.getByText("const newValue = 2;")).toBeVisible();
  await diff.locator(".edit-diff-sidebar-header > button").click();
  await expect(diff).not.toHaveClass(/is-open/);
  await expect(diff).toHaveAttribute("aria-hidden", "true");
  await expect(diff).toHaveAttribute("inert", "");
  await process.getByRole("button", { name: "收起过程" }).click();
  await expect(process).not.toHaveAttribute("open", "");
});

test("answer footer shows the producing model and copies the complete visible answer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await openSecondSession(page);
  const answer = page.locator(".message-assistant", { hasText: "Final answer with" });
  await expect(answer.locator(".message-model")).toHaveText("test / gpt-e2e");
  await answer.getByRole("button", { name: "复制整个回答" }).click();
  await expect(answer.getByRole("button", { name: "回答已复制" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Final **answer** with `$x = 1$`.");
});
