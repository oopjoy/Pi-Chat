import { test, expect } from "./fixtures";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

for (const cancellation of ["abort", "reload"] as const) {
  test(`routed response remains readable after browser ${cancellation}`, { tag: "@desktop-only" }, async ({ page }) => {
    await page.goto("/");
    const fetched = barrier(), release = barrier(), finished = barrier();
    let body: { ok?: boolean } | undefined;
    await page.route("**/api/health?route-lifetime=1", async (route) => {
      const response = await route.fetch();
      fetched.release();
      await release.promise;
      body = await response.json();
      await route.fulfill({ response });
      finished.release();
    });
    try {
      const failed = cancellation === "abort"
        ? page.waitForEvent("requestfailed", (request) => request.url().includes("route-lifetime=1"))
        : Promise.resolve();
      await page.evaluate(() => {
        const controller = new AbortController();
        window.addEventListener("abort-fixture-fetch", () => controller.abort(), { once: true });
        // Cancellation of this browser-side request is intentional. The route
        // handler itself must still read/fulfill without swallowing errors.
        void fetch("/api/health?route-lifetime=1", { signal: controller.signal }).catch(() => {});
      });
      await fetched.promise;
      if (cancellation === "abort")
        await page.evaluate(() => window.dispatchEvent(new Event("abort-fixture-fetch")));
      else await page.reload({ waitUntil: "commit" });
      await failed;
      release.release();
      await finished.promise;
      expect(body?.ok).toBe(true);
    } finally {
      release.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

test("route drain finishes response readers before context disposal", { tag: "@desktop-only" }, async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const fetched = barrier(), release = barrier();
  let bodyRead = false;
  await page.route("**/api/health?route-lifetime=2", async (route) => {
    const response = await route.fetch();
    fetched.release();
    await release.promise;
    expect((await response.json()).ok).toBe(true);
    await route.fulfill({ response });
    bodyRead = true;
  });
  try {
    await page.goto(baseURL!);
    await page.evaluate(() => { void fetch("/api/health?route-lifetime=2"); });
    await fetched.promise;
    let drained = false;
    const drain = page.unrouteAll({ behavior: "wait" }).then(() => { drained = true; });
    // No sleeps: the callback is held at a known point after route.fetch().
    await Promise.resolve();
    expect(bodyRead).toBe(false);
    expect(drained).toBe(false);
    release.release();
    await drain;
    expect(bodyRead).toBe(true);
  } finally {
    release.release();
    await page.unrouteAll({ behavior: "wait" });
    await context.close();
  }
});

test("context disposal deterministically invalidates a fetched response body", { tag: "@desktop-only" }, async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  try {
    const response = await context.request.get(`${baseURL}/api/health`);
    expect(response.status()).toBe(200);
    await context.close();
    // Negative control: this is the exact APIResponse.json failure from CI,
    // unlike abort/reload while the owning context is still alive.
    await expect(response.json()).rejects.toThrow("Response has been disposed");
  } finally {
    await context.close();
  }
});
