import { build } from "vite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const distRoot = resolve(process.env.PI_CHAT_DIST_DIR || "dist");
const buildIdentity = JSON.parse(await readFile(resolve(distRoot, "build-identity.json"), "utf8"));
await build({
  configFile: resolve("vite.config.ts"),
  define: {
    __PI_CHAT_BUILD_IDENTITY__: JSON.stringify(buildIdentity),
  },
  build: {
    outDir: resolve(distRoot, "web"),
    emptyOutDir: true,
  },
});
