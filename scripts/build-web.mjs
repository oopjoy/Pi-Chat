import { build } from "vite";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertBrowserStreamingBenchmarkStaging,
  parseBrowserStreamingBenchmarkPolicy,
} from "./streaming-cadence-config.mjs";

const distRoot = resolve(process.env.PI_CHAT_DIST_DIR || "dist");
const buildIdentity = JSON.parse(await readFile(resolve(distRoot, "build-identity.json"), "utf8"));
const browserStreamingPolicy = parseBrowserStreamingBenchmarkPolicy(
  process.env.PI_CHAT_BENCHMARK_BROWSER_STREAMING_POLICY,
);
assertBrowserStreamingBenchmarkStaging(
  browserStreamingPolicy,
  distRoot,
  resolve("dist"),
);
await build({
  configFile: resolve("vite.config.ts"),
  define: {
    __PI_CHAT_BUILD_IDENTITY__: JSON.stringify(buildIdentity),
    __PI_CHAT_BENCHMARK_BROWSER_STREAMING_POLICY__: JSON.stringify(browserStreamingPolicy),
  },
  build: {
    outDir: resolve(distRoot, "web"),
    emptyOutDir: true,
  },
});
if (process.env.PI_CHAT_BENCHMARK_BROWSER_STREAMING_POLICY !== undefined) {
  const webRoot = resolve(distRoot, "web");
  const html = await readFile(resolve(webRoot, "index.html"), "utf8");
  const entry = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1]?.replace(/^\/+/, "");
  if (!entry) throw new Error("Streaming benchmark Web entry asset is unavailable");
  const entryBytes = await readFile(resolve(webRoot, entry));
  await writeFile(
    resolve(webRoot, "streaming-benchmark-policy.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      browserPolicy: browserStreamingPolicy,
      entrySha256: createHash("sha256").update(entryBytes).digest("hex"),
    }, null, 2)}\n`,
    "utf8",
  );
}
