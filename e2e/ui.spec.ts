import { expect, test } from "./fixtures";

async function openSecondSession(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator(".session-item", { hasText: "Second session" })).toBeVisible();
  await page.locator(".session-item", { hasText: "Second session" }).click();
  await expect(page.getByText("Final answer with")).toBeVisible();
}

test("desktop session navigation keeps the left sidebar open", { tag: "@desktop-only" }, async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toHaveClass(/is-open/);
  await page.locator(".session-item", { hasText: "Second session" }).click();
  await expect(page.getByText("Final answer with")).toBeVisible();
  await expect(sidebar).toHaveClass(/is-open/);
});

test("desktop composer keeps Model and Thinking labels clear of their dropdown affordances", { tag: "@desktop-only" }, async ({ page }) => {
  await page.goto("/");
  for (const selector of [".composer-model-select", ".thinking-control"]) {
    const control = page.locator(selector);
    const trigger = control.locator(".compact-select-trigger");
    const chevron = trigger.locator(".compact-select-chevron");
    await expect(control).toBeVisible();
    await expect(chevron).toBeVisible();
    const metrics = await trigger.evaluate((element) => {
      const labelElement = element.querySelector<HTMLElement>("span")!;
      const chevronElement = element.querySelector<HTMLElement>(".compact-select-chevron")!;
      const triggerBox = element.getBoundingClientRect();
      const labelBox = labelElement.getBoundingClientRect();
      const chevronBox = chevronElement.getBoundingClientRect();
      return {
        labelFits: labelElement.scrollWidth <= labelElement.clientWidth,
        chevronInsideTrigger: chevronBox.left >= triggerBox.left && chevronBox.right <= triggerBox.right,
        labelEndsBeforeChevron: labelBox.right <= chevronBox.left + 0.5,
      };
    });
    expect(metrics.labelFits).toBe(true);
    expect(metrics.chevronInsideTrigger).toBe(true);
    expect(metrics.labelEndsBeforeChevron).toBe(true);
  }
});

test("sidebar-width desktop Composer keeps its controls and actions inside the pane", { tag: "@desktop-only" }, async ({ page }) => {
  await page.setViewportSize({ width: 761, height: 720 });
  await page.goto("/");
  await expect(page.locator(".sidebar")).toHaveClass(/is-open/);
  const [controls, composer, attachment, send] = [
    page.locator(".composer-controls"),
    page.locator(".composer"),
    page.locator(".composer .attachment-button:visible"),
    page.locator(".composer .send-button:visible"),
  ];
  await expect(controls).toBeVisible();
  await expect(attachment).toBeVisible();
  await expect(send).toBeVisible();
  const [controlMetrics, composerBox, attachmentBox, sendBox] = await Promise.all([
    controls.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
    composer.boundingBox(),
    attachment.boundingBox(),
    send.boundingBox(),
  ]);
  expect(controlMetrics.scrollWidth).toBeLessThanOrEqual(controlMetrics.clientWidth);
  for (const actionBox of [attachmentBox, sendBox]) {
    expect(actionBox!.x).toBeGreaterThanOrEqual(composerBox!.x - 0.5);
    expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(composerBox!.x + composerBox!.width + 0.5);
  }
});

test("narrow Composer keeps visible Fast-mode contents within its viewport", { tag: "@desktop-only" }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  const controls = page.locator(".composer-controls");
  const usage = page.locator(".composer-usage");
  await expect(controls).toBeVisible();
  await usage.evaluate((element) => {
    element.classList.add("has-fast-mode");
    const indicator = document.createElement("span");
    indicator.className = "fast-mode-indicator";
    indicator.setAttribute("aria-hidden", "true");
    indicator.innerHTML = '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-13h-7z" /></svg>';
    element.append(indicator);
  });
  const [controlMetrics, usageMetrics] = await Promise.all([
    controls.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const childrenFit = [...element.children].every((child) => {
        const childBox = child.getBoundingClientRect();
        return childBox.left >= box.left - 0.5 && childBox.right <= box.right + 0.5;
      });
      return { childrenFit, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    }),
    usage.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const contentsFit = [...element.querySelectorAll(":scope > .context-donut, :scope > span")].every((child) => {
        const childBox = child.getBoundingClientRect();
        return childBox.left >= box.left - 0.5 && childBox.right <= box.right + 0.5;
      });
      return { contentsFit, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    }),
  ]);
  expect(controlMetrics.childrenFit).toBe(true);
  expect(controlMetrics.scrollWidth).toBeLessThanOrEqual(controlMetrics.clientWidth);
  expect(usageMetrics.contentsFit).toBe(true);
  expect(usageMetrics.scrollWidth).toBeLessThanOrEqual(usageMetrics.clientWidth);
});

test("sidebar search clear stays at the field edge and restores input focus", { tag: "@desktop-only" }, async ({ page }) => {
  let releaseBootstrap!: () => void;
  let markBootstrapIntercepted!: () => void;
  let bootstrapReleased = false;
  const heldBootstrap = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  const bootstrapIntercepted = new Promise<void>((resolve) => { markBootstrapIntercepted = resolve; });
  const releaseHeldBootstrap = () => {
    if (bootstrapReleased) return;
    bootstrapReleased = true;
    releaseBootstrap();
  };
  await page.route("**/api/bootstrap", async (route) => {
    markBootstrapIntercepted();
    await heldBootstrap;
    const requestUrl = new URL(route.request().url());
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: requestUrl.origin },
    });
    const data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, workspaceCwd: "C:/authoritative-default" },
    });
  });
  try {
    await page.goto("/");
    await bootstrapIntercepted;
    await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sessions");
    await expect(page.locator(".session-item", { hasText: "First session" })).toBeVisible();
    const search = page.getByRole("searchbox", { name: "搜索对话" });
    await search.fill("First");
    const clear = page.getByRole("button", { name: "清除对话搜索" });
    await expect(clear).toBeVisible();
    const bootstrapResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bootstrap");
    releaseHeldBootstrap();
    const hydratedBootstrap = await bootstrapResponse;
    expect((await hydratedBootstrap.json()).workspaceCwd).toBe("C:/authoritative-default");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(search).toHaveValue("First");
    await expect(clear).toBeVisible();
    const [searchBox, clearBox] = await Promise.all([
      search.boundingBox(),
      clear.boundingBox(),
    ]);
    expect(searchBox).not.toBeNull();
    expect(clearBox).not.toBeNull();
    expect(searchBox!.x + searchBox!.width - (clearBox!.x + clearBox!.width)).toBeLessThanOrEqual(4);
    expect(clearBox!.x).toBeGreaterThan(searchBox!.x + searchBox!.width - 34);
    await clear.click();
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    await expect(clear).toHaveCount(0);
  } finally {
    releaseHeldBootstrap();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("a mismatched Web artifact blocks mutations but keeps guarded recovery actions", { tag: "@desktop-only" }, async ({ page, mismatchedBaseURL }) => {
  await page.goto(mismatchedBaseURL);
  await expect(page.getByText("网页与服务版本不一致")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息输入" })).toBeDisabled();
  await expect(page.locator(".new-chat")).toBeDisabled();
  await expect(page.getByRole("button", { name: "完整重启 Pi Chat 并应用更新" })).toBeEnabled();

  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("button", { name: "关闭 Pi Chat" })).toBeEnabled();
});

test("cold navigation uses a target-labelled loading pane before replacing the source transcript", { tag: "@desktop-only" }, async ({ page }) => {
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

test("cold and hot-memory navigation emit bounded first-pane measurements during a real stream", { tag: "@desktop-only" }, async ({ page }) => {
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

test("focusing a cold Session keeps it neutral until the first send starts Pi", { tag: "@desktop-only" }, async ({ page }) => {
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

test("mobile session navigation closes the left sidebar", { tag: "@mobile-only" }, async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toHaveClass(/is-open/);
  await page.locator(".session-item", { hasText: "Second session" }).click();
  await expect(page.getByText("Final answer with")).toBeVisible();
  await expect(sidebar).not.toHaveClass(/is-open/);
});

test("image preview stays inside the viewport and restores thumbnail focus", { tag: "@desktop-mobile" }, async ({ page }) => {
  await openSecondSession(page);
  const thumbnail = page.getByRole("button", { name: "查看用户附加图片的大图" });
  await thumbnail.focus();
  await thumbnail.click();
  const dialog = page.getByRole("dialog", { name: "用户附加图片预览" });
  const image = dialog.locator("img");
  const close = dialog.getByRole("button", { name: "关闭图片预览" });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  for (const box of [await dialog.boundingBox(), await image.boundingBox()]) {
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  }
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(thumbnail).toBeFocused();
});

test("long Runtime notice remains in flow above an unobscured Composer", { tag: "@desktop-mobile" }, async ({ page }) => {
  const longNotice = "Refresh failed because the session inventory is temporarily unavailable. ".repeat(8);
  await page.goto("/");
  await page.route("**/api/bootstrap", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: longNotice }),
  }));
  await page.getByRole("button", { name: "刷新会话列表" }).click();
  const notice = page.locator(".app-toast.error");
  const composer = page.locator(".composer");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(longNotice);
  await expect(composer).toBeVisible();
  const [noticeBox, composerBox, viewport, noticeMetrics] = await Promise.all([
    notice.boundingBox(), composer.boundingBox(), page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
    notice.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
  ]);
  expect(noticeBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(noticeMetrics.scrollWidth).toBeLessThanOrEqual(noticeMetrics.clientWidth + 1);
  expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(composerBox!.y);
  expect(noticeBox!.x).toBeGreaterThanOrEqual(0);
  expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(composerBox!.x).toBeGreaterThanOrEqual(0);
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(viewport.width);
});

test("forced colors keeps CompactSelect focus and active option visibly outlined", { tag: "@forced-only" }, async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  // Wait for the initial Session projection before asserting focus. Draft/view
  // restoration may legitimately focus the Composer while bootstrap is still
  // committing, which would make this CSS-focused assertion race page startup.
  await expect(page.getByText("First answer")).toBeVisible();
  const trigger = page.getByRole("button", { name: "模型" });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveCSS("outline-style", "solid");
  await trigger.press("ArrowDown");
  const listbox = page.getByRole("listbox", { name: "模型" });
  await expect(listbox).toBeFocused();
  await listbox.press("ArrowDown");
  const activeOption = listbox.locator("[role='option']").nth(1);
  await expect(activeOption).toHaveAttribute("id", await listbox.getAttribute("aria-activedescendant") || "");
  const forcedColorsDiagnostic = await activeOption.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      forcedColors: matchMedia("(forced-colors: active)").matches,
      outlineStyle: style.outlineStyle,
      borderTopStyle: style.borderTopStyle,
      backgroundColor: style.backgroundColor,
      color: style.color,
    };
  });
  expect(forcedColorsDiagnostic.forcedColors).toBe(true);
  expect(forcedColorsDiagnostic.outlineStyle).toBe("solid");
});

test("session search filters locally and pin persists across reload", { tag: "@desktop-only" }, async ({ page }) => {
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

test("directory groups collapse, search temporarily expands, and fixed state persists", { tag: "@desktop-only" }, async ({ page }) => {
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

test("Files and Changes sidebar reads workspace files, shows Edit diffs, and remains inert while hidden", { tag: "@desktop-only" }, async ({ page }) => {
  await openSecondSession(page);
  await page.getByRole("button", { name: "展开文件与变更侧栏" }).click();
  const diff = page.locator(".edit-diff-sidebar");
  await expect(diff).toHaveClass(/is-open/);
  const readme = diff.locator(".workspace-file-row.is-file", { hasText: "README.md" });
  await expect(readme).toBeVisible();
  await readme.click();
  await expect(diff.locator(".workspace-file-preview pre")).toContainText("Readable file preview");
  await diff.locator(".workspace-inspector-header > button").click();

  const process = page.locator(".conversation-process");
  await process.locator(":scope > summary").click();
  await expect(process).toHaveAttribute("open", "");
  await process.locator(".process-edit-entry button").click();
  await expect(diff).toHaveClass(/is-open/);
  await expect(diff.getByText("const newValue = 2;")).toBeVisible();
  await diff.locator(".workspace-inspector-header > button").click();
  await expect(diff).not.toHaveClass(/is-open/);
  await expect(diff).toHaveAttribute("aria-hidden", "true");
  await expect(diff).toHaveAttribute("inert", "");
  await process.getByRole("button", { name: "收起过程" }).click();
  await expect(process).not.toHaveAttribute("open", "");
});

test("answer footer shows the producing model and copies the complete visible answer", { tag: "@desktop-only" }, async ({ page }) => {
  await openSecondSession(page);
  const answer = page.locator(".message-assistant", { hasText: "Final answer with" });
  await expect(answer.locator(".message-model")).toHaveText("test / gpt-e2e");
  await answer.getByRole("button", { name: "复制整个回答" }).click();
  await expect(answer.getByRole("button", { name: "回答已复制" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Final **answer** with `$x = 1$`.");
});
