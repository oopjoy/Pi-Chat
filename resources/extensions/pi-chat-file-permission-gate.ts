/**
 * Pi Chat File Permission Gate
 * Pi Chat system component: file-permission-gate; version: 1
 *
 * 随 Pi Chat 发布：严格模式确认 write/edit，并对能明确识别的高风险 Bash
 * 命令额外确认。Bash 可运行任意 shell、PowerShell 或脚本，无法完整识别全部
 * 副作用；这是一层辅助防护，不是 sandbox。
 * 覆盖的工具：write, edit, bash（已识别的高风险命令）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

type GateMode = "strict" | "open";

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
		description: "Control file permission gate: /gate status|open|strict",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (!command || command === "status") {
				ctx.ui.notify(
					`Gate mode: ${gateMode}\nCommands: /gate open, /gate strict, /gate status`,
					"info",
				);
				return;
			}

			if (["open", "off", "allow", "disable"].includes(command)) {
				gateMode = "open";
				// Always lead with "Gate mode: …" so Pi Chat UI can resync after RPC restart.
				ctx.ui.notify(
					"Gate mode: open\nwrite/edit and recognized high-risk Bash commands will be allowed without prompts. Use /gate strict to re-enable prompts.",
					"warning",
				);
				return;
			}

			if (["strict", "on", "close", "closed", "enable"].includes(command)) {
				gateMode = "strict";
				ctx.ui.notify("Gate mode: strict\nwrite/edit will ask for confirmation; recognized high-risk Bash commands will also ask. Bash side-effect detection is limited.", "info");
				return;
			}

			ctx.ui.notify("Usage: /gate status|open|strict", "warning");
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
			if (!ctx.hasUI) {
				ctx.ui?.notify?.(`Blocked ${tool}: ${displayName} (no interactive UI)`, "warning");
				return { block: true, reason: "File write/edit blocked: no UI for confirmation" };
			}

			const qualifier = tool === "write" && isDelete ? " · contains deletion" : "";
			const choice = await ctx.ui.select(
				`Pi Chat Gate · ${tool}${qualifier}\n\n${fullPath}`,
				["Allow", "Block"],
			);

			if (choice !== "Allow") {
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
			if (!ctx.hasUI) {
				return { block: true, reason: "Destructive bash command blocked (no UI)" };
			}

			const choice = await ctx.ui.select(
				`Pi Chat Gate · bash\n\n${command}`,
				["Allow", "Block"],
			);

			if (choice !== "Allow") {
				return { block: true, reason: "Blocked by user" };
			}

			return undefined;
		}

		// 其他工具（read, etc）不拦截
		return undefined;
	});
}
