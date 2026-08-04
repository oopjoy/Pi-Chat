import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../src/shared/types";
import { sessionStatus } from "../src/web/components/SessionSidebar";

const session = (patch: Partial<SessionSummary>): SessionSummary => ({
  id: "session", sessionId: "session", name: "Session", preview: "", cwd: "C:/work", updatedAt: 0, messageCount: 1,
  ...patch,
});

test("sidebar separates normal work from confirmation, paused work, failure, and unseen completion", () => {
  const activity = (execution: "idle" | "queued" | "dispatching" | "running" | "paused" | "failed", awaitingConfirmation = false) => ({ activity: { execution, awaitingConfirmation } });
  assert.deepEqual(sessionStatus(session({ writable: false }), false, false), { kind: "idle", label: "对话空闲" });
  assert.deepEqual(sessionStatus(session(activity("queued")), false, true), { kind: "running", label: "消息等待自动执行" });
  assert.deepEqual(sessionStatus(session({ ...activity("dispatching"), queued: true }), false, true), { kind: "running", label: "正在派发队列消息" });
  assert.deepEqual(sessionStatus(session(activity("running")), false, true), { kind: "running", label: "正在生成" });
  assert.deepEqual(sessionStatus(session(activity("idle", true)), false, true), { kind: "pending", label: "等待权限确认" });
  assert.deepEqual(sessionStatus(session(activity("paused", true)), false, true), { kind: "error", label: "队列已暂停，需要恢复或撤销" });
  assert.deepEqual(sessionStatus(session(activity("failed")), false, true), { kind: "error", label: "会话运行异常" });
  assert.deepEqual(sessionStatus(session(activity("idle")), false, true), { kind: "unread", label: "有新回复" });
});

test("status and menu share a right-side slot while metadata remains text-only", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = resolve(import.meta.dirname, "..");
  const [css, sidebar] = await Promise.all([
    readFile(resolve(root, "src/web/styles.css"), "utf8"),
    readFile(resolve(root, "src/web/components/SessionSidebar.tsx"), "utf8"),
  ]);
  assert.match(sidebar, /if \(elapsed < 60_000\) return "now"/);
  assert.match(sidebar, /if \(elapsed < 3_600_000\) return `\$\{Math\.floor\(elapsed \/ 60_000\)\} m`/);
  assert.match(sidebar, /if \(elapsed < 86_400_000\) return `\$\{Math\.floor\(elapsed \/ 3_600_000\)\} h`/);
  assert.match(sidebar, /new Intl\.DateTimeFormat\("en-US", \{ month: "numeric", day: "numeric" \}\)/);
  assert.match(sidebar, /title=\{`\$\{session\.name\}\\n\$\{relativeTime\(session\.updatedAt\)\} · \$\{session\.turnCount \?\? session\.messageCount\} turns · \$\{session\.messageCount\} messages`\}/);
  assert.match(sidebar, /<span className="session-meta">\{relativeTime\(session\.updatedAt\)\}<\/span>/);
  assert.doesNotMatch(sidebar, /session-meta[^\n]*session-status/);
  assert.match(sidebar, /session-item-actions[^\n]*>[\s\S]*session-status[\s\S]*session-menu-trigger/);
  assert.match(css, /\.session-item\s*\{[^}]*display:\s*flex[^}]*min-height:\s*36px[^}]*padding:\s*7px\s+12px/s);
  assert.match(css, /\.session-meta\s*\{[^}]*flex:\s*0\s+0\s+auto[^}]*text-align:\s*right/s);
  assert.match(css, /\.session-row\.has-status \.session-meta[^}]*visibility:\s*hidden/s);
  assert.match(css, /\.session-row:hover \.session-meta[^}]*visibility:\s*hidden/s);
  assert.match(css, /\.session-item-actions\s*\{[^}]*display:\s*grid[^}]*width:\s*29px[^}]*height:\s*29px/s);
  assert.match(css, /\.session-menu-trigger\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s);
  assert.doesNotMatch(css, /\.session-menu-trigger\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.session-row:hover \.session-menu-trigger[\s\S]*\.session-row:hover \.session-status[\s\S]*opacity:\s*0/s);
  assert.match(css, /\.session-status\.is-unread::before/);
});

test("directory rows use normal text color and indent their child sessions without a guide line", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const css = await readFile(resolve(import.meta.dirname, "..", "src/web/styles.css"), "utf8");

  assert.match(css, /\.session-directory-toggle\s*\{[^}]*padding:\s*7px\s+8px\s+7px\s+4px[^}]*color:\s*var\(--text\)/s);
  assert.match(css, /\.session-directory-toggle small\s*\{[^}]*color:\s*var\(--text\)/s);
  assert.match(css, /\.session-directory-pin\s*\{[^}]*color:\s*var\(--text\)/s);
  assert.match(css, /\.session-directory-items\s*\{[^}]*margin-left:\s*13px/s);
  assert.match(css, /\.session-name\s*\{[^}]*font-weight:\s*500/s);
  assert.doesNotMatch(css, /\.session-directory-items\s*\{[^}]*border-left/s);
});
