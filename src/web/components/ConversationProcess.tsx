import { useMemo } from "react";
import type { ProcessEntry } from "../lib/conversation-process";
import { AlertIcon, CheckIcon } from "./Icons";

function summarize(entries: ProcessEntry[], streaming = false): string {
  const tools = entries.filter((entry): entry is Extract<ProcessEntry, { kind: "tool" }> => entry.kind === "tool");
  const thinking = entries.some((entry) => entry.kind === "thinking");
  const failed = tools.filter((entry) => entry.isError).length;
  const subagents = tools.filter((entry) => entry.name === "subagent").length;
  const labels: string[] = [];
  if (thinking) labels.push(streaming ? "思考中" : "思考");
  if (tools.length) labels.push(`${tools.length} 个工具`);
  if (subagents) labels.push(`${subagents} 个子任务`);
  if (!labels.length) labels.push(streaming ? "进行中" : `${entries.length} 个步骤`);
  return `过程 · ${labels.join(" · ")}${failed ? ` · ${failed} 项失败` : ""}`;
}

export function ConversationProcess({ entries, streaming = false }: { entries: ProcessEntry[]; streaming?: boolean }) {
  const summary = useMemo(() => summarize(entries, streaming), [entries, streaming]);
  const hasFailures = entries.some((entry) => entry.kind === "tool" && entry.isError);
  return (
    <div className={`conversation-process${streaming ? " is-streaming" : ""}`}>
      <span className="conversation-process-summary process-summary-label">
        {hasFailures ? <AlertIcon className="process-status-icon is-error" /> : streaming ? <span className="process-status-icon is-running" aria-hidden="true" /> : <CheckIcon className="process-status-icon" />}
        {summary}
      </span>
    </div>
  );
}
