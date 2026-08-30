import type { ToolEditDiff } from "./tool-edit-diff";

export const OPEN_DIFF_EVENT = "pi-chat-open-edit-diff";

/** Open the Changes inspector without importing its UI bundle. */
export function openEditDiffSidebar(diff: ToolEditDiff): void {
  window.dispatchEvent(new window.CustomEvent<ToolEditDiff>(OPEN_DIFF_EVENT, { detail: diff }));
}
