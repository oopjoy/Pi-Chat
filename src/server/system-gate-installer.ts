import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PI_CHAT_GATE_TARGET = "pi-chat-file-permission-gate.ts";
export const PI_CHAT_GATE_MARKER = "Pi Chat system component: file-permission-gate; version: 1";

export type SystemGateInstallResult = "installed" | "verified" | "repaired" | "conflict" | "source-missing";

export interface SystemGateInstallOptions {
  agentDir: string;
  sourcePath: string;
}

export interface SystemGateInstallReport {
  status: SystemGateInstallResult;
  targetPath?: string;
  diagnostic?: string;
}

function legacyComparable(content: string): string {
  return content.replace(/^\/\*\*[\s\S]*?\*\/\r?\n\r?\n/, "").replace(/\r\n/g, "\n");
}

async function contentHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function ensureGateEnabled(agentDir: string): Promise<void> {
  const settingsPath = join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>; } catch {}
  const relativeTarget = `extensions/${PI_CHAT_GATE_TARGET}`;
  const extensions = Array.isArray(settings.extensions) ? settings.extensions.filter((entry): entry is string => typeof entry === "string") : [];
  settings.extensions = [...extensions.filter((entry) => entry.replace(/^[+\-!]/, "").replace(/\\/g, "/") !== relativeTarget), `+${relativeTarget}`];
  const temporary = `${settingsPath}.pi-chat-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporary, settingsPath);
}

async function replaceAtomically(source: string, target: string): Promise<void> {
  const temporary = `${target}.pi-chat-${process.pid}-${Date.now()}.tmp`;
  await copyFile(source, temporary, constants.COPYFILE_EXCL);
  await rename(temporary, target);
}

/**
 * The actual tool-call hook must remain a Pi Extension, but it is a Pi Chat
 * system component rather than a user-managed plugin. Keep its source of truth
 * with Pi Chat and self-heal the installed adapter when it becomes stale.
 */
export async function ensurePiChatSystemGate({ agentDir, sourcePath }: SystemGateInstallOptions): Promise<SystemGateInstallReport> {
  if (!existsSync(sourcePath)) return { status: "source-missing", diagnostic: "未找到 Pi Chat 内置安全执行组件源文件" };
  const extensionDir = join(agentDir, "extensions");
  const targetPath = join(extensionDir, PI_CHAT_GATE_TARGET);
  const legacyPath = join(extensionDir, "file-permission-gate.ts");
  await mkdir(extensionDir, { recursive: true });
  // Pi Chat 0.1 shipped the same adapter under the generic legacy name. Migrate
  // only byte-for-byte-equivalent adapter logic; a customized user Gate is never
  // touched, because two /gate implementations would make enforcement ambiguous.
  if (existsSync(legacyPath)) {
    const [legacy, source] = await Promise.all([readFile(legacyPath, "utf8"), readFile(sourcePath, "utf8")]);
    if (legacyComparable(legacy) === legacyComparable(source)) {
      await rename(legacyPath, `${legacyPath}.pi-chat-legacy-disabled`);
    } else {
      return { status: "conflict", targetPath, diagnostic: "检测到自定义旧版 file-permission-gate.ts；为避免两个 /gate 处理器冲突，Pi Chat 未启用内置安全组件。请移除或改名旧组件后重新启动。" };
    }
  }
  let installed = false;
  if (!existsSync(targetPath)) {
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL).then(() => { installed = true; }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }
  if (installed) {
    await ensureGateEnabled(agentDir);
    return { status: "installed", targetPath };
  }
  const [sourceHash, targetHash] = await Promise.all([contentHash(sourcePath), contentHash(targetPath)]);
  if (sourceHash === targetHash) {
    await ensureGateEnabled(agentDir);
    return { status: "verified", targetPath };
  }
  const targetContent = await readFile(targetPath, "utf8");
  if (!targetContent.includes(PI_CHAT_GATE_MARKER)) {
    return { status: "conflict", targetPath, diagnostic: "同名文件不是 Pi Chat 安全组件，已保留且未覆盖；请更名或移走后重新启动 Pi Chat。" };
  }
  await replaceAtomically(sourcePath, targetPath);
  await ensureGateEnabled(agentDir);
  return { status: "repaired", targetPath, diagnostic: "Pi Chat 内置安全执行组件已更新/修复。" };
}
