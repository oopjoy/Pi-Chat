import { expect, test } from "./fixtures";

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

test("cold navigation uses a target-labelled loading pane before replacing the source transcript", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await page.goto("/");
  await expect(page.getByText("First answer")).toBeVisible();

  let releaseTargetView!: () => void;
  let targetViewUrl = "";
  const targetViewHeld = new Promise<void>((resolve) => { releaseTargetView = resolve; });
  await page.route(/\/api\/sessions\/[^/]+\/view(?:\?|$)/, async (route) => {
    targetViewUrl = route.request().url();
    await targetViewHeld;
    await route.continue();
  });

  await page.locator(".session-item", { hasText: "Second session" }).click();
  const loadingPane = page.locator(".pane-loading");
  await expect(loadingPane).toContainText("正在打开 Second session");
  await expect(page.getByText("First answer")).toHaveCount(0);
  // The target is deliberately cold: a hot Session would ask for fast=1.
  expect(targetViewUrl).not.toContain("fast=1");

  releaseTargetView();
  await expect(page.getByText("Final answer with")).toBeVisible();
  await expect(loadingPane).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("cold and hot-memory navigation emit bounded first-pane measurements during a real stream", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  const installMetricObserver = () => page.evaluate(() => {
    (window as Window & { paneCommits?: Array<{ source: string; elapsedMs: number }> }).paneCommits = [];
    window.addEventListener("pi-chat:pane-first-commit", ((event: CustomEvent<{ source: string; elapsedMs: number }>) => {
      (window as Window & { paneCommits?: Array<{ source: string; elapsedMs: number }> }).paneCommits?.push(event.detail);
    }) as EventListener);
  });
  await page.goto("/");
  await installMetricObserver();
  const second = page.locator(".session-item", { hasText: "Second session" });
  await second.click();
  await expect(page.getByText("Final answer with")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Window & { paneCommits?: Array<{ source: string; elapsedMs: number }> }).paneCommits || [])).toContainEqual(expect.objectContaining({ source: "cold-jsonl" }));
  const cold = await page.evaluate(() => (window as Window & { paneCommits?: Array<{ source: string; elapsedMs: number }> }).paneCommits?.find((commit) => commit.source === "cold-jsonl"));
  expect(cold?.elapsedMs).toBeLessThan(2_000);

  await page.getByRole("textbox", { name: "消息输入" }).fill("exercise streaming metric");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText("Live response complete")).toBeVisible();
  // A reload clears browser pane data but retains the hot Secondary worker, so
  // the next selection must use the server's fast in-memory projection.
  await page.reload();
  await installMetricObserver();
  // Reload restores Second as the selected session, so select First first; then
  // selecting the still-hot Secondary exercises the zero-I/O fast view.
  await page.locator(".session-item", { hasText: "First session" }).click();
  await expect(page.getByText("First answer")).toBeVisible();
  await page.locator(".session-item", { hasText: "Second session" }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { paneCommits?: Array<{ source: string; elapsedMs: number }> }).paneCommits || [])).toContainEqual(expect.objectContaining({ source: "hot-memory" }));
  const hot = await page.evaluate(() => (window as Window & { paneCommits?: Array<{ source: string; elapsedMs: number }> }).paneCommits?.find((commit) => commit.source === "hot-memory"));
  expect(hot?.elapsedMs).toBeLessThan(500);
});

test("focusing a cold Session keeps it neutral until the first send starts Pi", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await page.goto("/");
  const secondRow = page.locator(".session-row", { hasText: "Second session" });
  await secondRow.locator(".session-item").click();
  await expect(page.getByText("Final answer with")).toBeVisible();

  const composer = page.getByRole("textbox", { name: "消息输入" });
  await composer.focus();
  await expect(secondRow.locator(".session-status")).toHaveAttribute("aria-label", "对话空闲");
  const first = page.locator(".session-item", { hasText: "First session" });
  await expect(first).toBeEnabled();
  await first.click();
  await expect(page.getByText("First answer")).toBeVisible();
  await expect(composer).toBeEnabled();
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

test("session search filters locally and pin persists across reload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await page.goto("/");
  const secondRow = page.locator(".session-row", { hasText: "Second session" });
  await secondRow.hover();
  await secondRow.getByRole("button", { name: "Second session 的操作菜单" }).click();
  await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
  await expect(page.locator(".session-row").first()).toContainText("Second session");
  await expect(page.locator(".session-row").first().locator(".session-pin-indicator")).toBeVisible();

  await page.reload();
  await expect(page.locator(".session-row").first()).toContainText("Second session");
  await page.locator(".session-row").first().hover();
  await page.locator(".session-row").first().getByRole("button", { name: "Second session 的操作菜单" }).click();
  await expect(page.getByRole("menuitem", { name: "取消置顶", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  const search = page.getByRole("searchbox", { name: "搜索对话" });
  await search.fill("first session");
  await expect(page.locator(".session-row")).toHaveCount(1);
  await expect(page.locator(".session-row").first()).toContainText("First session");
  await search.fill("");
  await expect(page.locator(".session-row")).toHaveCount(2);
  await expect(page.locator(".session-row").first()).toContainText("Second session");
});

test("directory groups collapse, search temporarily expands, and fixed state persists", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop");
  await page.goto("/");
  const directory = page.locator(".session-directory").first();
  const toggle = directory.locator(".session-directory-toggle");
  const fixed = directory.locator(".session-directory-pin");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await fixed.click();
  await expect(fixed).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(directory.locator(".session-row")).toHaveCount(0);

  const search = page.getByRole("searchbox", { name: "搜索对话" });
  await search.fill("first session");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(directory.locator(".session-row")).toHaveCount(1);
  await search.fill("");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(directory.locator(".session-row")).toHaveCount(0);

  await page.reload();
  const restored = page.locator(".session-directory").first();
  await expect(restored.locator(".session-directory-pin")).toHaveAttribute("aria-pressed", "true");
  await expect(restored.locator(".session-directory-toggle")).toHaveAttribute("aria-expanded", "false");
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
