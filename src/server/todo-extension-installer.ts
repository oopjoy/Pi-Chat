import { constants, existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

export type BundledExtensionInstallResult = "installed" | "already-installed" | "legacy-extension" | "source-missing";
/** @deprecated Use BundledExtensionInstallResult. */
export type TodoExtensionInstallResult = BundledExtensionInstallResult;

export interface BundledExtensionInstallOptions {
  agentDir: string;
  sourcePath: string;
  targetName: string;
  legacyNames?: string[];
}

/**
 * Installs one bundled Pi Extension exactly once. It remains a normal user-level
 * Pi extension, so it works in Pi CLI as well as Pi Chat. Existing implementations
 * are never overwritten, including a separately installed legacy extension.
 */
export async function ensureBundledExtension({
  agentDir,
  sourcePath,
  targetName,
  legacyNames = [],
}: BundledExtensionInstallOptions): Promise<BundledExtensionInstallResult> {
  const extensionDir = join(agentDir, "extensions");
  const target = join(extensionDir, targetName);
  if (existsSync(target)) return "already-installed";
  if (legacyNames.some((name) => existsSync(join(extensionDir, basename(name))))) return "legacy-extension";
  if (!existsSync(sourcePath)) return "source-missing";

  await mkdir(extensionDir, { recursive: true });
  try {
    await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
    return "installed";
  } catch (error) {
    // A second Pi Chat process can race the first process during initial startup.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "already-installed";
    throw error;
  }
}

/** Backward-compatible Todo-specific entry point. */
export function ensurePiChatTodoExtension(options: Omit<BundledExtensionInstallOptions, "targetName" | "legacyNames"> & { targetName?: string; legacyNames?: string[] }): Promise<TodoExtensionInstallResult> {
  return ensureBundledExtension({ targetName: "pi-chat-todo.ts", legacyNames: ["local-todo.ts"], ...options });
}
