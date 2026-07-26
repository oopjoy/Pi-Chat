export interface EditDiffLine {
  kind: "add" | "delete";
  text: string;
}

export interface EditDiffHunk {
  lines: EditDiffLine[];
}

export interface ToolEditDiff {
  path: string;
  additions: number;
  deletions: number;
  sensitive: boolean;
  truncated: boolean;
  hunks: EditDiffHunk[];
}

const MAX_DIFF_LINES = 400;
const MAX_DIFF_CHARACTERS = 40_000;

export function compactEditPath(path: string, maxSegments = 3): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return path;
  if (parts.length <= maxSegments) return parts.join("/");
  return `…/${parts.slice(-maxSegments).join("/")}`;
}

function lines(value: string): string[] {
  if (!value) return [];
  const result = value.replace(/\r\n/g, "\n").split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function sensitivePath(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() || "";
  return name === ".env" || name.startsWith(".env.") || name.includes("credential") || name.includes("secret");
}

export function editDiffFromToolCall(name: string, value: unknown): ToolEditDiff | null {
  if (name.toLowerCase() !== "edit" || !value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.path !== "string" || !input.path || !Array.isArray(input.edits) || !input.edits.length) return null;
  const edits = input.edits.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const replacement = entry as Record<string, unknown>;
    if (typeof replacement.oldText !== "string" || typeof replacement.newText !== "string") return [];
    return [{ oldLines: lines(replacement.oldText), newLines: lines(replacement.newText) }];
  });
  if (!edits.length) return null;

  const additions = edits.reduce((total, edit) => total + edit.newLines.length, 0);
  const deletions = edits.reduce((total, edit) => total + edit.oldLines.length, 0);
  const sensitive = sensitivePath(input.path);
  if (sensitive) return { path: input.path, additions, deletions, sensitive, truncated: false, hunks: [] };

  let lineBudget = MAX_DIFF_LINES;
  let characterBudget = MAX_DIFF_CHARACTERS;
  let truncated = false;
  const hunks: EditDiffHunk[] = [];
  for (const edit of edits) {
    const hunk: EditDiffHunk = { lines: [] };
    for (const [kind, source] of [["delete", edit.oldLines], ["add", edit.newLines]] as const) {
      for (const text of source) {
        if (lineBudget <= 0 || characterBudget < text.length) {
          truncated = true;
          break;
        }
        hunk.lines.push({ kind, text });
        lineBudget -= 1;
        characterBudget -= text.length;
      }
      if (truncated) break;
    }
    if (hunk.lines.length) hunks.push(hunk);
    if (truncated) break;
  }
  return { path: input.path, additions, deletions, sensitive, truncated, hunks };
}
