import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { validateDistTarget } from "./dist-paths.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const { target } = validateDistTarget({
  projectRoot,
  requested: process.env.PI_CHAT_DIST_DIR || "dist",
});
await rm(target, { recursive: true, force: true });
