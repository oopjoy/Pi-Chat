import { build } from "vite";
import { resolve } from "node:path";

const distRoot = resolve(process.env.PI_CHAT_DIST_DIR || "dist");
await build({
  configFile: resolve("vite.config.ts"),
  build: {
    outDir: resolve(distRoot, "web"),
    emptyOutDir: true,
  },
});
