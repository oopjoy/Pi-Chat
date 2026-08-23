import { closeSync, writeSync } from "node:fs";

try {
  writeSync(3, "R\n");
} catch {
  // Startup diagnostics are fail-open and never participate in Runtime readiness.
} finally {
  try { closeSync(3); } catch {}
}
