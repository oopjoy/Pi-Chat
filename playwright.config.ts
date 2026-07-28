import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalTeardown: "./scripts/e2e-teardown.mjs",
  use: {
    baseURL: "http://127.0.0.1:30179",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] } },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"], permissions: ["clipboard-read", "clipboard-write"] } },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:30179/api/bootstrap",
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
