/**
 * Pi Chat Todo Extension
 *
 * 随 Pi Chat 发布，为 Pi 注册 todo 工具（add / toggle / clear / list）与
 * /todo 命令。通过 ctx.ui.setWidget 显示进度，并把状态写入会话 custom entry，
 * 因此待办列表可以随会话保存，也会在分支切换时恢复。
 *
 * 为兼容原 PiDeck Todo 扩展产生的历史会话，本扩展继续使用 "pi-deck-todo"
 * 作为状态 entry 类型；这只是持久化格式标识，不构成对 PiDeck 的运行时依赖。
 *
 * 若后加载的第三方扩展覆盖同名 todo 工具，本扩展会停止刷新自己的 widget，
 * 避免陈旧状态与重复界面。
 *
 * @packageDocumentation
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoState {
	todos: Todo[];
	nextId: number;
}

// 工具结果 details：携带当前完整状态，便于 LLM 与桌面端渲染时直接读取
interface TodoDetails extends TodoState {
	action: "list" | "add" | "toggle" | "clear";
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

// 独立 widget 标识；entry 类型沿用旧值以读取既有 PiDeck Todo 状态。
const WIDGET_KEY = "local-todo";
const ENTRY_TYPE = "pi-deck-todo";
// sourceInfo.path / source 含此串，说明当前生效的是本扩展注册的 todo 工具。
const SELF_MARKER = "pi-chat-todo";

export default function (pi: ExtensionAPI) {
	// 内存状态：session_start / session_tree 时从会话快照重建
	let todos: Todo[] = [];
	let nextId = 1;
	// 是否已让位给第三方 todo 扩展；让位后不显示 widget、不重建状态、命令转引导
	let yielded = false;

	/**
	 * 判断当前生效的 "todo" 工具是否仍是本扩展注册的（未被第三方覆盖）。
	 * 只在自身已注册后调用：sourceInfo 含 SELF_MARKER 说明本扩展的注册仍生效。
	 */
	function isOwnTodo(): boolean {
		const t = pi.getAllTools().find((x) => x.name === "todo");
		const info = t?.sourceInfo as { path?: string; source?: string } | undefined;
		return Boolean(info?.path?.includes(SELF_MARKER) || info?.source?.includes(SELF_MARKER));
	}

	/** 把当前状态写入会话 custom entry，供后续 session_start / 分支切换时重建 */
	function persistState(): void {
		pi.appendEntry(ENTRY_TYPE, { todos, nextId });
	}

	/** 刷新桌面端 widget：空列表清除，非空显示完成进度与各项 */
	function updateWidget(ctx: ExtensionContext): void {
		if (todos.length > 0) {
			const done = todos.filter((t) => t.done).length;
			ctx.ui.setWidget(WIDGET_KEY, [
				`待办事项 ${done}/${todos.length}`,
				...todos.map((t) => `${t.done ? "☑" : "☐"} #${t.id} ${t.text}`),
			]);
		} else {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	/**
	 * 从会话 entries 重建状态：取最后一条 pi-deck-todo 快照。
	 * 分支切换后 getEntries 返回该分支的 entries，状态自动跟随分支。
	 */
	function reconstructState(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === ENTRY_TYPE)
			.pop() as { data?: TodoState } | undefined;
		todos = last?.data?.todos ?? [];
		nextId = last?.data?.nextId ?? 1;
	}

	// 立即注册（运行时初始化后 getAllTools 才能调用，因此无法在 default 里做加载顺序检测）。
	// 若被后加载的第三方覆盖（Map.set 后注册覆盖前注册），session_start 的 isOwnTodo()
	// 会判定为 yielded，停掉 widget 并让命令转引导。
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list. Actions: list (show all), add (text), toggle (id), clear (remove all). Progress is shown in the Pi UI widget.",
		promptSnippet: "Manage a todo list (add / toggle / clear)",
		promptGuidelines: [
			"Use the todo tool to track multi-step work: add items before starting, toggle done as you complete each step, clear when finished.",
			"Toggle by id; call list first if you need to see current ids.",
			"Todo state is per-branch — switching branches restores that branch's list automatically.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let error: string | undefined;

			switch (params.action) {
				case "add": {
					const text = params.text?.trim();
					if (!text) {
						error = "text required for add";
						break;
					}
					todos.push({ id: nextId++, text, done: false });
					break;
				}
				case "toggle": {
					if (params.id === undefined) {
						error = "id required for toggle";
						break;
					}
					const target = todos.find((t) => t.id === params.id);
					if (!target) {
						error = `#${params.id} not found`;
						break;
					}
					target.done = !target.done;
					break;
				}
				case "clear": {
					todos = [];
					nextId = 1;
					break;
				}
				case "list":
				default:
					// list 只读，不改状态
					break;
			}

			// 仅在状态实际变更时持久化；list 与出错仍刷新 widget 以保持桌面端与内存一致
			if (params.action !== "list" && !error) {
				persistState();
			}
			updateWidget(ctx);

			const details: TodoDetails = {
				action: params.action,
				todos: [...todos],
				nextId,
				...(error ? { error } : {}),
			};

			// 工具结果文本：让 LLM 与桌面端默认渲染都能直接读懂当前状态
			let text: string;
			if (error) {
				text = `Error: ${error}`;
			} else if (params.action === "list") {
				text = todos.length
					? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
					: "No todos";
			} else if (params.action === "add") {
				const added = todos[todos.length - 1];
				text = `Added todo #${added.id}: ${added.text}`;
			} else if (params.action === "toggle") {
				const t = todos.find((x) => x.id === params.id);
				text = `Todo #${params.id} ${t?.done ? "completed" : "uncompleted"}`;
			} else {
				text = "Cleared all todos";
			}

			return {
				content: [{ type: "text" as const, text }],
				details,
			};
		},
	});

	// /todo 命令：用户手动查看当前列表。
	pi.registerCommand("todo", {
		description: "查看当前分支待办事项",
		handler: async (_args, ctx) => {
			// 被第三方覆盖时转而引导，避免显示本扩展的陈旧/空状态
			if (!isOwnTodo()) {
				ctx.ui.notify("Todo 工具由其他扩展提供，请使用其对应命令（如 /todos）查看。", "info");
				return;
			}
			if (todos.length === 0) {
				ctx.ui.notify("还没有待办事项，可以告诉 AI 添加。", "info");
				return;
			}
			const done = todos.filter((t) => t.done).length;
			ctx.ui.notify(
				[`Todos ${done}/${todos.length}`, ...todos.map((t) => `${t.done ? "☑" : "☐"} #${t.id} ${t.text}`)].join("\n"),
				"info",
			);
		},
	});

	// 会话启动 / 分支切换时从快照重建状态并刷新 widget。
	// session_start 同时承担让位策略 2 的复核：若被后加载的第三方覆盖则 yielded。
	pi.on("session_start", async (_event, ctx) => {
		if (!isOwnTodo()) {
			yielded = true;
			return;
		}
		yielded = false;
		reconstructState(ctx);
		updateWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (yielded || !isOwnTodo()) {
			yielded = true;
			return;
		}
		reconstructState(ctx);
		updateWidget(ctx);
	});
}
