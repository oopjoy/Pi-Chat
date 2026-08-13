import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium-desktop", grep: /@desktop-only|@desktop-mobile/, grepInvert: /@mobile-only|@forced-only/, use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] } },
    { name: "chromium-mobile", grep: /@mobile-only|@desktop-mobile/, grepInvert: /@desktop-only|@forced-only/, use: { ...devices["Pixel 7"], permissions: ["clipboard-read", "clipboard-write"] } },
    { name: "chromium-forced-colors", grep: /@forced-only/, grepInvert: /@desktop-only|@mobile-only|@desktop-mobile/, use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 }, forcedColors: "active", permissions: ["clipboard-read", "clipboard-write"] } },
  ],
});
