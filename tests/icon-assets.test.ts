import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("browser favicon and installed PWA use separate versioned icon assets", async () => {
  const html = await readFile(resolve(root, "src/web/index.html"), "utf8");
  const manifest = JSON.parse(await readFile(resolve(root, "src/web/public/manifest.webmanifest"), "utf8")) as {
    theme_color?: string;
    icons?: Array<{ src?: string; sizes?: string }>;
  };
  const favicon = html.match(/<link rel="icon" href="([^"]+)"/)?.[1];
  const manifestHref = html.match(/<link rel="manifest" href="([^"]+)"/)?.[1];
  const pwaIcons = manifest.icons || [];

  assert.equal(manifest.theme_color, "#78b8f5");
  assert.match(manifestHref || "", /manifest\.webmanifest\?v=4$/);
  assert.match(favicon || "", /pi-chat-favicon-v3-192\.png\?v=4$/);
  assert.deepEqual(pwaIcons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  assert.ok(pwaIcons.every((icon) => /pi-chat-pwa-v3-\d+\.png\?v=4$/.test(icon.src || "")));
  assert.ok(pwaIcons.every((icon) => icon.src !== favicon));
});
