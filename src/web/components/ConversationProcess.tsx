import { useMemo } from "react";
import type { ProcessEntry } from "../lib/conversation-process";
import { AlertIcon, CheckIcon } from "./Icons";
import { MarkdownBody } from "./MarkdownBody";

function summarize(entries: ProcessEntry[]): string {
  const tools = entries.filter((entry): entry is Extract<ProcessEntry, { kind: "tool" }> => entry.kind === "tool");
  const thinking = entries.some((entry) => entry.kind === "thinking");
  const failed = tools.filter((entry) => entry.isError).length;
  const subagents = tools.filter((entry) => entry.name === "subagent").length;
  const labels: string[] = [];
  if (thinking) labels.push("思考");
  if (tools.length) labels.push(`${tools.length} 个工具`);
  if (subagents) labels.push(`${subagents} 个子任务`);
  if (!labels.length) labels.push(`${entries.length} 个步骤`);
  return `过程 · ${labels.join(" · ")}${failed ? ` · ${failed} 项失败` : ""}`;
}

function toolLabel(entry: Extract<ProcessEntry, { kind: "tool" }>): string {
  const state = entry.isError ? "失败" : entry.result ? "完成" : "已调用";
  return `${entry.name} · ${state}`;
}

export function ConversationProcess({ entries }: { entries: ProcessEntry[] }) {
  const summary = useMemo(() => summarize(entries), [entries]);
  const hasFailures = entries.some((entry) => entry.kind === "tool" && entry.isError);
  return (
    <details className="conversation-process">
      <summary><span className="process-summary-label">{hasFailures ? <AlertIcon className="process-status-icon is-error" /> : <CheckIcon className="process-status-icon" />}{summary}</span><span className="conversation-process-chevron" aria-hidden="true"><svg className="chevron-collapsed" viewBox="0 0 16 16"><path d="M10 3.5 5.5 8 10 12.5" /></svg><svg className="chevron-expanded" viewBox="0 0 16 16"><path d="M3.5 6 8 10.5 12.5 6" /></svg></span></summary>
      <div className="conversation-process-body">
        {entries.map((entry, index) => {
          if (entry.kind === "thinking") {
            return <details className="process-entry process-thinking" key={`thinking-${index}`}>
              <summary>思考</summary>
              <pre>{entry.text}</pre>
            </details>;
          }
          if (entry.kind === "note") {
            return <div className="process-entry process-note" key={`note-${index}`}><MarkdownBody>{entry.text}</MarkdownBody></div>;
          }
          return <details className={`process-entry process-tool ${entry.isError ? "is-error" : ""}`} key={entry.id || `tool-${index}`}>
            <summary><span className="process-summary-label">{entry.isError ? <AlertIcon className="process-status-icon is-error" /> : <CheckIcon className="process-status-icon" />}{toolLabel(entry)}</span></summary>
            {(entry.arguments || entry.result) && <div className="process-tool-detail">
              {entry.arguments && <section><strong>调用参数</strong><pre>{entry.arguments}</pre></section>}
              {entry.result && <section><strong>{entry.isError ? "错误信息" : "结果"}</strong><pre>{entry.result}</pre></section>}
            </div>}
          </details>;
        })}
      </div>
    </details>
  );
}
