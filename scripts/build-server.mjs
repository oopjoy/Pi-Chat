import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { build } from "esbuild";

const distRoot = resolve(process.env.PI_CHAT_DIST_DIR || "dist");
const tsc = resolve("node_modules", "typescript", "bin", "tsc");
const child = spawn(process.execPath, [tsc, "-p", "tsconfig.server.json", "--outDir", resolve(distRoot, "server")], {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: true,
});
const code = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code ?? 1));
});
if (code !== 0) {
  process.exitCode = code;
} else {
  // Keep parser dependencies self-contained: portable releases do not ship
  // node_modules, while the rest of the server remains ordinary tsc output.
  await build({
    entryPoints: [resolve("src/server/markdown-links.ts")],
    outfile: resolve(distRoot, "server/server/markdown-links.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
}
