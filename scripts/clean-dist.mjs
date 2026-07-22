import { rm } from "node:fs/promises";
import { resolve } from "node:path";

await rm(resolve(process.env.PI_CHAT_DIST_DIR || "dist"), { recursive: true, force: true });
