import type { ApplicationLifecycle } from "../../shared/types";

const applicationLifecycles = new Set<ApplicationLifecycle>([
  "idle",
  "restarting",
  "shutting-down",
  "workspace-changing",
  "resources-reloading",
  "models-refreshing",
]);

/**
 * Admit an untyped SSE lifecycle observation without manufacturing a browser
 * state for an unknown server payload. Server lifecycle remains authoritative;
 * this is only projection input validation.
 */
export function acceptApplicationLifecycle(
  current: ApplicationLifecycle,
  incoming: unknown,
): ApplicationLifecycle {
  return typeof incoming === "string" && applicationLifecycles.has(incoming as ApplicationLifecycle)
    ? incoming as ApplicationLifecycle
    : current;
}
