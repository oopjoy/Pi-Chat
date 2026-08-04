import { join, resolve } from "node:path";

export function e2eRuntimeDist(environment = process.env, projectRoot = resolve(import.meta.dirname, "..")) {
  return resolve(environment.PI_CHAT_E2E_DIST || environment.PI_CHAT_DIST_DIR || join(projectRoot, "dist"));
}
