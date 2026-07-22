import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const distRoot = resolve(process.env.PI_CHAT_DIST_DIR || "dist");
await rm(resolve(distRoot, "resources"), { recursive: true, force: true });
await cp(resolve("resources"), resolve(distRoot, "resources"), { recursive: true });
