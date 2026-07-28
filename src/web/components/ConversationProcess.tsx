import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProcessEntry } from "../lib/conversation-process";
import { AlertIcon, CheckIcon, ChevronUpIcon } from "./Icons";
import { openEditDiffSidebar } from "./EditToolDiff";
import { compactEditPath } from "../lib/tool-edit-diff";
import { MarkdownBody } from "./MarkdownBody";

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

export function toolLabel(entry: Extract<ProcessEntry, { kind: "tool" }>): string {
  if (entry.isError) return `${entry.name} · 失败`;
  return entry.completed ? entry.name : `${entry.name} · 已调用`;
}

const disclosureState = new Map<string, boolean>();
const MAX_DISCLOSURE_ENTRIES = 1_000;

function rememberDisclosure(key: string, open: boolean): void {
  disclosureState.delete(key);
  disclosureState.set(key, open);
  while (disclosureState.size > MAX_DISCLOSURE_ENTRIES) {
    const oldest = disclosureState.keys().next().value;
    if (!oldest) break;
    disclosureState.delete(oldest);
  }
}

function PersistentDetails({ disclosureKey, className, children, footerCollapse = false }: { disclosureKey: string; className: string; children: ReactNode; footerCollapse?: boolean }) {
  const [open, setOpen] = useState(() => disclosureState.get(disclosureKey) || false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => setOpen(disclosureState.get(disclosureKey) || false), [disclosureKey]);
  const setDisclosure = (next: boolean) => {
    setOpen(next);
    rememberDisclosure(disclosureKey, next);
  };
  const collapse = () => {
    const details = detailsRef.current;
    setDisclosure(false);
    const revealSummary = () => details?.scrollIntoView?.({ block: "nearest" });
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(revealSummary);
    else revealSummary();
  };
  return <details ref={detailsRef} className={className} open={open} onClick={(event) => {
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    const summary = target?.closest?.("summary") || null;
    // Nested thinking/tool summaries bubble through the outer details. Only the
    // summary directly owned by this details controls this disclosure record.
    if (!summary || summary.parentElement !== event.currentTarget) return;
    event.preventDefault();
    setDisclosure(!open);
  }}>
    {children}
    {footerCollapse && open && <div className="conversation-process-footer">
      <button type="button" onClick={collapse}><ChevronUpIcon /><span>收起过程</span></button>
    </div>}
  </details>;
}

function ThinkingEntry({ text, disclosureKey }: { text: string; disclosureKey: string }) {
  return <PersistentDetails className="process-entry process-thinking" disclosureKey={disclosureKey}>
    <summary>思考</summary>
    <pre>{text}</pre>
  </PersistentDetails>;
}

export function ConversationProcess({ entries, streaming = false, disclosureKey = "process" }: { entries: ProcessEntry[]; streaming?: boolean; disclosureKey?: string }) {
  const summary = useMemo(() => summarize(entries, streaming), [entries, streaming]);
  const hasFailures = entries.some((entry) => entry.kind === "tool" && entry.isError);
  const status = hasFailures ? <AlertIcon className="process-status-icon is-error" /> : streaming ? <span className="process-status-icon is-running" aria-hidden="true" /> : <CheckIcon className="process-status-icon" />;

  return <PersistentDetails className={`conversation-process${streaming ? " is-streaming" : ""}`} disclosureKey={disclosureKey} footerCollapse>
    <summary><span className="conversation-process-summary process-summary-label">{status}{summary}</span><span className="conversation-process-chevron" aria-hidden="true"><svg className="chevron-collapsed" viewBox="0 0 16 16"><path d="M10 3.5 5.5 8 10 12.5" /></svg><svg className="chevron-expanded" viewBox="0 0 16 16"><path d="M3.5 6 8 10.5 12.5 6" /></svg></span></summary>
    <div className="conversation-process-body">
      {entries.map((entry, index) => {
        if (entry.kind === "thinking") {
          return <ThinkingEntry key={`thinking-${index}`} text={entry.text} disclosureKey={`${disclosureKey}:thinking:${index}`} />;
        }
        if (entry.kind === "note") return <div className="process-entry process-note" key={`note-${index}`}><MarkdownBody>{entry.text}</MarkdownBody></div>;
        if (entry.editDiff) {
          const editDiff = entry.editDiff;
          const name = compactEditPath(editDiff.path);
          const completed = entry.completed === true && !entry.isError;
          return <div className={`process-entry process-tool process-edit-entry${entry.isError ? " is-error" : ""}`} key={entry.id || `tool-${index}`}>
            <button type="button" title={editDiff.path} disabled={!completed} onClick={() => { if (completed) openEditDiffSidebar(editDiff); }}>
              {entry.isError ? <AlertIcon className="process-status-icon is-error" /> : completed ? <CheckIcon className="process-status-icon" /> : <span className="process-status-icon is-running" aria-hidden="true" />}
              <span>edit</span>
              <strong>{name}</strong>
              <span className="process-edit-stats"><b>+{editDiff.additions}</b><i>-{editDiff.deletions}</i></span>
              {!completed && <em>{entry.isError ? "失败" : "执行中…"}</em>}
            </button>
            {entry.isError && entry.result && <div className="process-tool-detail"><section><strong>错误信息</strong><pre>{entry.result}</pre></section></div>}
          </div>;
        }
        const toolKey = entry.id || `tool-${index}`;
        return <PersistentDetails className={`process-entry process-tool ${entry.isError ? "is-error" : ""}`} disclosureKey={`${disclosureKey}:${toolKey}`} key={toolKey}>
          <summary><span className="process-summary-label">{entry.isError ? <AlertIcon className="process-status-icon is-error" /> : entry.completed ? <CheckIcon className="process-status-icon" /> : <span className="process-status-icon is-running" aria-hidden="true" />}{toolLabel(entry)}</span></summary>
          {(entry.arguments || entry.result) && <div className="process-tool-detail">
            {entry.arguments && <section><strong>调用参数</strong><pre>{entry.arguments}</pre></section>}
            {entry.result && <section><strong>{entry.isError ? "错误信息" : "结果"}</strong><pre>{entry.result}</pre></section>}
          </div>}
        </PersistentDetails>;
      })}
    </div>
  </PersistentDetails>;
}
