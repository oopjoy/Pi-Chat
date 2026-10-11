import { resolvePiEntry, resolvePiVersion } from "../dist/server/server/rpc-client.js";

try {
  const entry = resolvePiEntry();
  process.stdout.write(JSON.stringify(entry ? { entry, version: resolvePiVersion(entry) } : null));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
