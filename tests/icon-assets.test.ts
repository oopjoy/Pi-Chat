import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("browser favicon and installed PWA use separate standalone install assets", async () => {
  const html = await readFile(resolve(root, "src/web/index.html"), "utf8");
  const manifest = JSON.parse(await readFile(resolve(root, "src/web/public/manifest.webmanifest"), "utf8")) as {
    display?: string;
    start_url?: string;
    theme_color?: string;
    icons?: Array<{ src?: string; sizes?: string; type?: string }>;
  };
  const favicon = html.match(/<link rel="icon" href="([^"]+)"/)?.[1];
  const manifestHref = html.match(/<link rel="manifest" href="([^"]+)"/)?.[1];
  const pwaIcons = manifest.icons || [];

  assert.match(manifestHref || "", /^\/manifest\.webmanifest(?:\?[^\"]+)?$/);
  assert.match(favicon || "", /^\/icons\/[^?]+\.png(?:\?[^\"]+)?$/);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.theme_color, "#78b8f5");
  assert.deepEqual(pwaIcons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  assert.ok(pwaIcons.every((icon) => /^\/icons\/[^?]+\.png(?:\?[^\"]+)?$/.test(icon.src || "")));
  assert.ok(pwaIcons.every((icon) => icon.type === "image/png"));
  const faviconPath = new URL(favicon || "", "https://local.test").pathname;
  assert.ok(pwaIcons.every((icon) => new URL(icon.src || "", "https://local.test").pathname !== faviconPath));
});
