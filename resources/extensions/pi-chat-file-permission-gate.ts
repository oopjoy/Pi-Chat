/**
 * Pi Chat File Permission Gate
 * Pi Chat system component: file-permission-gate; version: 2
 *
 * Strict mode confirms write/edit and clearly recognized high-risk Bash commands.
 * This is an auxiliary confirmation layer, not a sandbox.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

type GateMode = "strict" | "open";

// Match command boundaries in both shell syntax and multiline scripts.
const destructiveBashPatterns = [
	/(?:^|[;&|\r\n]\s*)(?:sudo\s+)?rm(?:\s|$)/im,
	/(?:^|[;&|\r\n]\s*)(?:sudo\s+)?(?:del|rmdir|shred|Remove-Item|ri|rd)(?:\s|$)/im,
	/(?:^|[;&|\r\n]\s*)(?:sudo\s+)?mv\b[^;|\r\n]*\/dev\/null/i,
	/(?:^|[;&|\r\n]\s*)git\s+clean\b[^;|\r\n]*\s-f[^;|\r\n]*d[^;|\r\n]*x(?:\s|$)/im,
	/(?:^|[;&|\r\n]\s*)git\s+reset\s+--hard(?:\s|$)/im,
];

export function isDestructiveBashCommand(command: string): boolean {
	return destructiveBashPatterns.some((pattern) => pattern.test(command));
}

export default function (pi: ExtensionAPI) {
	let gateMode: GateMode = "strict";

	pi.registerCommand("gate", {
		description: "Toggle file permission gate: /gate [status|open|strict]",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (command === "status") {
				ctx.ui.notify(`Gate mode: ${gateMode}`, "info");
				return;
			}

			// Bare /gate toggles between the two modes.
			if (!command) {
				gateMode = gateMode === "strict" ? "open" : "strict";
				ctx.ui.notify(`Gate mode: ${gateMode}`, gateMode === "open" ? "warning" : "info");
				return;
			}

			if (["open", "off", "allow", "disable"].includes(command)) {
				gateMode = "open";
				ctx.ui.notify("Gate mode: open", "warning");
				return;
			}

			if (["strict", "on", "close", "closed", "enable"].includes(command)) {
				gateMode = "strict";
				ctx.ui.notify("Gate mode: strict", "info");
				return;
			}

			ctx.ui.notify("Usage: /gate [status|open|strict]", "warning");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;

		if (tool === "write" || tool === "edit") {
			const input = event.input as any;
			const filePath = typeof input.path === "string"
				? input.path
				: typeof input.file_path === "string" ? input.file_path : undefined;
			const displayName = filePath ? path.basename(filePath) : "(unknown)";
			const fullPath = filePath || "(unknown path)";

			// Only edit operations can express deletion through an empty newText.
			const edits = input.edits;
			const isDelete = tool === "edit" && Array.isArray(edits) && edits.some(
				(e: any) => typeof e?.newText === "string" && e.newText.length === 0,
			);

			if (gateMode === "open") return undefined;
			if (!ctx.hasUI) {
				ctx.ui.notify(`Blocked ${tool}: ${displayName} (no interactive UI)`, "warning");
				return { block: true, reason: "File write/edit blocked: no UI for confirmation" };
			}

			const qualifier = isDelete ? " · contains deletion" : "";
			const choice = await ctx.ui.select(
				`Pi Chat Gate · ${tool}${qualifier}\n\n${fullPath}`,
				["Allow", "Block"],
			);

			if (choice !== "Allow") {
				return { block: true, reason: `Blocked by user: ${tool} ${displayName}` };
			}
			return undefined;
		}

		if (tool === "bash") {
			const command = ((event.input as any).command as string) || "";
			const isDestructive = isDestructiveBashCommand(command);
			if (!isDestructive || gateMode === "open") return undefined;

			if (!ctx.hasUI) {
				return { block: true, reason: "Destructive bash command blocked (no UI)" };
			}

			const choice = await ctx.ui.select(
				`Pi Chat Gate · bash\n\n${command}`,
				["Allow", "Block"],
			);

			if (choice !== "Allow") return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});
}
