import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

const origin = "http://127.0.0.1:30179";
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export default async function teardown() {
  try {
    const bootstrap = await fetch(`${origin}/api/bootstrap`, { signal: AbortSignal.timeout(3_000) });
    const data = await bootstrap.json();
    if (bootstrap.ok && data.requestToken) {
      await fetch(`${origin}/api/shutdown`, {
        method: "POST",
        headers: {
          origin,
          "x-pi-chat-token": data.requestToken,
        },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
    }
  } catch {
    // The test server may already have exited.
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const names = (await readdir(tmpdir(), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-chat-e2e-"))
      .map((entry) => join(tmpdir(), entry.name));
    if (!names.length) return;
    await Promise.all(names.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
    await delay(100 * (attempt + 1));
  }
}
