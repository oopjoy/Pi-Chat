import { useMemo } from "react";
import type { ProcessEntry } from "../lib/conversation-process";
import { MarkdownBody } from "./MarkdownBody";

function summarize(entries: ProcessEntry[]): string {
  const tools = entries.filter((entry): entry is Extract<ProcessEntry, { kind: "tool" }> => entry.kind === "tool");
  const thinking = entries.some((entry) => entry.kind === "thinking");
  const failed = tools.filter((entry) => entry.isError).length;
  const labels: string[] = [];
  if (thinking) labels.push("思考");
  if (tools.length) labels.push(`${tools.length} 个工具`);
  if (!labels.length) labels.push(`${entries.length} 个步骤`);
  return `${failed ? "⚠" : "✓"} 过程 · ${labels.join(" · ")}${failed ? ` · ${failed} 项失败` : ""}`;
}

function toolLabel(entry: Extract<ProcessEntry, { kind: "tool" }>): string {
  const state = entry.isError ? "失败" : entry.result ? "完成" : "已调用";
  return `${entry.isError ? "!" : "✓"} ${entry.name} · ${state}`;
}

export function ConversationProcess({ entries }: { entries: ProcessEntry[] }) {
  const summary = useMemo(() => summarize(entries), [entries]);
  return (
    <details className="conversation-process">
      <summary><span>{summary}</span><span className="conversation-process-chevron" aria-hidden="true">⌄</span></summary>
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
            <summary>{toolLabel(entry)}</summary>
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
