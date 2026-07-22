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
  const thoughts = entries.filter((entry): entry is Extract<ProcessEntry, { kind: "thinking" }> => entry.kind === "thinking");
  const status = hasFailures ? <AlertIcon className="process-status-icon is-error" /> : streaming ? <span className="process-status-icon is-running" aria-hidden="true" /> : <CheckIcon className="process-status-icon" />;
  const label = <span className="conversation-process-summary process-summary-label">{status}{summary}</span>;
  const className = `conversation-process${streaming ? " is-streaming" : ""}`;

  // The summary remains concise; only private thinking is available on expand.
  // Tool completion rows, arguments, and results intentionally stay hidden.
  if (!thoughts.length) return <div className={className}>{label}</div>;
  return <details className={className}>
    <summary>{label}<span className="conversation-process-chevron" aria-hidden="true"><svg className="chevron-collapsed" viewBox="0 0 16 16"><path d="M10 3.5 5.5 8 10 12.5" /></svg><svg className="chevron-expanded" viewBox="0 0 16 16"><path d="M3.5 6 8 10.5 12.5 6" /></svg></span></summary>
    <div className="conversation-process-body">
      {thoughts.map((thought, index) => <pre className="process-thinking" key={`thinking-${index}`}>{thought.text}</pre>)}
    </div>
  </details>;
}
