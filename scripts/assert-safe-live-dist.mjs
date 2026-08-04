import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const liveDist = resolve(projectRoot, "dist");
const requestedDist = resolve(projectRoot, process.env.PI_CHAT_DIST_DIR || "dist");

// Application restart builds into a sibling staging tree and promotes it only
// after its own lifecycle barrier. A direct build replaces live dist instead,
// so never let it overwrite assets served by an already-running Pi Chat.
if (requestedDist !== liveDist) process.exit(0);

const port = Number(process.env.PI_CHAT_PORT || 30170);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Pi Chat 构建前检查失败：PI_CHAT_PORT 必须是 1 到 65535 之间的整数。");
  process.exit(1);
}

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(1_200),
  });
  const health = await response.json().catch(() => null);
  if (response.ok && health?.ok === true && health?.service === "pi-chat") {
    const identity = typeof health.buildIdentity?.fingerprint === "string"
      ? health.buildIdentity.fingerprint.slice(0, 12)
      : "unknown";
    console.error(
      `拒绝直接覆盖正在运行的 Pi Chat dist（127.0.0.1:${port}，构建 ${identity}）。请先在网页中使用“完整重启 Pi Chat 并应用更新”，或先关闭 Pi Chat；直接 npm run build 会让旧服务混用新网页资源。`,
    );
    process.exit(1);
  }
} catch {
  // No compatible listener owns the default local endpoint, so a direct build
  // cannot replace assets being served by this Pi Chat instance.
}
