import { spawn } from "node:child_process";
import { resolve } from "node:path";

const distRoot = resolve(process.env.PI_CHAT_DIST_DIR || "dist");
const tsc = resolve("node_modules", "typescript", "bin", "tsc");
const child = spawn(process.execPath, [tsc, "-p", "tsconfig.server.json", "--outDir", resolve(distRoot, "server")], {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: true,
});
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  if (code !== 0) process.exitCode = typeof code === "number" ? code : signal ? 1 : 1;
});
