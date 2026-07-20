/**
 * Pi Chat File Permission Gate
 *
 * 随 Pi Chat 发布，拦截所有 写/编辑/删除 操作，弹窗请求用户确认后才能执行。
 * 覆盖的工具：write, edit, bash (rm/del)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

type GateMode = "strict" | "open" | "once";

export default function (pi: ExtensionAPI) {
	let gateMode: GateMode = "strict";

	const destructiveBashPatterns = [
		/\brm\s+-/i,
		/\brm\s+["']/i,
		/\bdel\b/i,
		/\brmdir\b/i,
		/\bmv\b.*\/dev\/null/i,
		/\bshred\b/i,
	];

	pi.registerCommand("gate", {
		description: "Control file permission gate: /gate status|open|strict|once",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (!command || command === "status") {
				ctx.ui.notify(
					`Gate mode: ${gateMode}\nCommands: /gate open, /gate strict, /gate once, /gate status`,
					"info",
				);
				return;
			}

			if (["open", "off", "allow", "disable"].includes(command)) {
				gateMode = "open";
				ctx.ui.notify(
					"Gate opened for this Pi runtime. write/edit and destructive bash will be allowed without prompts. Use /gate strict to re-enable prompts.",
					"warning",
				);
				return;
			}

			if (["strict", "on", "close", "closed", "enable"].includes(command)) {
				gateMode = "strict";
				ctx.ui.notify("Gate strict mode enabled. write/edit and destructive bash will ask for confirmation.", "info");
				return;
			}

			if (["once", "next"].includes(command)) {
				gateMode = "once";
				ctx.ui.notify("Gate will allow the next write/edit/destructive bash call, then return to strict mode.", "warning");
				return;
			}

			ctx.ui.notify("Usage: /gate status|open|strict|once", "warning");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;

		// --- write 和 edit：每次弹窗确认 ---
		if (tool === "write" || tool === "edit") {
			const filePath = (event.input as any).path as string;
			const displayName = filePath ? path.basename(filePath) : "(unknown)";
			const fullPath = filePath || "(unknown path)";

			const edits = (event.input as any).edits;
			const isDelete = edits && Array.isArray(edits) && edits.some(
				(e: any) => !e.newText || e.newText === ""
			);

			if (gateMode === "open") return undefined;
			if (gateMode === "once") {
				gateMode = "strict";
				ctx.ui?.notify?.(`Gate one-shot allow used for ${tool}: ${displayName}`, "info");
				return undefined;
			}

			if (!ctx.hasUI) {
				ctx.ui?.notify?.(`Blocked ${tool}: ${displayName} (no interactive UI)`, "warning");
				return { block: true, reason: "File write/edit blocked: no UI for confirmation" };
			}

			const actionLabel = tool === "write"
				? (isDelete ? "⚠️ Write (contains deletion)" : "📝 Write")
				: "✏️ Edit";
			const detail = tool === "write"
				? `Write to ${fullPath}`
				: `Edit ${fullPath}`;

			const choice = await ctx.ui.select(
				`${actionLabel}\n\n${detail}`,
				["✅ Allow", "❌ Block"],
			);

			if (choice !== "✅ Allow") {
				return { block: true, reason: `Blocked by user: ${tool} ${displayName}` };
			}

			return undefined;
		}

		// --- bash: 仅拦截包含删除指令的命令 ---
		if (tool === "bash") {
			const command = ((event.input as any).command as string) || "";

			const isDestructive = destructiveBashPatterns.some((p) => p.test(command));
			if (!isDestructive) return undefined;  // 安全命令直接放行

			if (gateMode === "open") return undefined;
			if (gateMode === "once") {
				gateMode = "strict";
				ctx.ui?.notify?.("Gate one-shot allow used for destructive bash.", "info");
				return undefined;
			}

			if (!ctx.hasUI) {
				return { block: true, reason: "Destructive bash command blocked (no UI)" };
			}

			const choice = await ctx.ui.select(
				`⚠️ Destructive bash command:\n\n  ${command}\n\nAllow?`,
				["✅ Allow", "❌ Block"],
			);

			if (choice !== "✅ Allow") {
				return { block: true, reason: "Blocked by user" };
			}

			return undefined;
		}

		// 其他工具（read, etc）不拦截
		return undefined;
	});
}
