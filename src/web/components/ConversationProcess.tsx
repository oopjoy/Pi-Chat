import { memo, Profiler, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProcessEntry } from "../lib/conversation-process";
import { reactRenderBenchmarkEnabled, recordReactRenderBenchmarkCommit } from "../lib/benchmark-profiler";
import { AlertIcon, CheckIcon, ChevronUpIcon, LightbulbIcon, PencilIcon } from "./Icons";
import { openEditDiffSidebar } from "../lib/edit-diff-events";
import { toolPresentation } from "../lib/tool-presentation";
import { compactEditPath } from "../lib/tool-edit-diff";
import { MarkdownBody } from "./MarkdownBody";

export function formatRunDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${two(hours)}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

function validRunTimestamp(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function useRunDuration(
  streaming: boolean,
  runStartedAt: number | null,
  runDurationMs: number | null,
): { label: string; title: string; dateTime?: string } | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!streaming || !validRunTimestamp(runStartedAt)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [streaming, runStartedAt]);
  const elapsed = streaming && validRunTimestamp(runStartedAt)
    ? Math.max(0, now - runStartedAt)
    : typeof runDurationMs === "number" && Number.isFinite(runDurationMs)
      ? Math.max(0, runDurationMs)
      : null;
  if (elapsed === null) return null;
  const active = streaming && validRunTimestamp(runStartedAt);
  const paused = streaming && !active;
  return {
    label: `${active ? "运行中" : paused ? "暂停" : "运行"} · ${formatRunDuration(elapsed)}`,
    title: active
      ? "过程运行时间（从 Pi 确认开始运行起计时，上游中断期间暂停）"
      : paused
        ? "上游中断，计时已暂停；恢复执行后继续累计"
        : `过程运行时间：${formatRunDuration(elapsed)}`,
    dateTime: `PT${Math.floor(elapsed / 1_000)}S`,
  };
}

type ToolEntry = Extract<ProcessEntry, { kind: "tool" }>;

function parseToolArguments(argumentsText: string | undefined): Record<string, unknown> | null {
  if (!argumentsText) return null;
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function compactToolValue(value: unknown, limit?: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return limit !== undefined && compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function compactToolPath(value: unknown, limit = 56): string | undefined {
  // Preserve the filename before applying the display bound to a long path.
  const compact = compactToolValue(value);
  if (!compact) return undefined;
  const normalized = compact.replaceAll("\\", "/");
  if (normalized.length <= limit) return normalized;
  const parts = normalized.split("/");
  let result = parts.at(-1) || normalized;
  if (result.length > limit - 2) return `…${result.slice(-(limit - 1))}`;
  for (let index = parts.length - 2; index >= 0 && result.length + parts[index]!.length + 3 <= limit; index -= 1)
    result = `${parts[index]}/${result}`;
  return `…/${result}`;
}

/** One-line, source-oriented context for an individual tool row. */
export function toolSummaryDetail(entry: ToolEntry): string | undefined {
  const args = parseToolArguments(entry.arguments);
  const name = entry.name || "工具";
  if (!args) return undefined;
  if (name === "read" || name === "write" || name === "edit")
    return compactToolPath(args.path);
  if (name === "bash" || name === "powershell")
    return compactToolValue(args.command, 76);
  if (name === "grep" || name === "find") {
    const pattern = compactToolValue(args.pattern ?? args.query, 42);
    const path = compactToolPath(args.path ?? args.cwd, 34);
    return pattern && path ? `${pattern} · ${path}` : pattern || path;
  }
  if (name === "intercom") {
    const action = compactToolValue(args.action, 24);
    const target = compactToolValue(args.to, 28);
    return action && target ? `${action} → ${target}` : action || target;
  }
  const firstValue = Object.values(args).find((value) => typeof value === "string");
  return compactToolValue(firstValue, 60);
}

export function toolSummary(entry: ToolEntry): string {
  const name = entry.name || "工具";
  const detail = toolSummaryDetail(entry);
  return detail ? `${name} ${detail}` : name;
}

/** Exported for regression tests: the narrative summary must stay fact-backed. */
export function processSummaryTitle(entries: ProcessEntry[], streaming = false): string {
  return summarize(entries, streaming);
}

/** Semantic buckets backed by confirmed tool names only. Unknown/extension tools stay generic. */
const READ_TOOLS = new Set(["read", "glob", "find"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit"]);
const SEARCH_TOOLS = new Set(["grep", "web_search", "antigravity_websearch"]);
const TERMINAL_TOOLS = new Set(["bash", "powershell"]);

/**
 * Narrative summary from confirmed facts only:
 * - counts completed tools per semantic bucket (a finished tool result exists);
 * - names the single running tool, or its bucket, as current work;
 * - unknown tools keep a generic count and are never guessed semantically.
 */
function summarize(entries: ProcessEntry[], streaming = false): string {
  const tools = entries.filter((entry): entry is ToolEntry => entry.kind === "tool");
  const failed = tools.filter((entry) => entry.isError).length;
  const running = tools.filter((entry) => !entry.completed && !entry.isError);
  const completed = tools.filter((entry) => entry.completed);
  const count = (set: Set<string>) => completed.filter((entry) => set.has(entry.name)).length;
  const read = count(READ_TOOLS);
  const edited = count(EDIT_TOOLS);
  const searched = count(SEARCH_TOOLS);
  const terminal = count(TERMINAL_TOOLS);
  const subagents = completed.filter((entry) => entry.name === "subagent").length;
  const known = read + edited + searched + terminal + subagents;
  const otherTools = completed.length - known;
  const parts: string[] = [];
  if (read) parts.push(`读取 ${read} 个文件`);
  if (searched) parts.push(`检索 ${searched} 次`);
  if (edited) parts.push(`修改 ${edited} 个文件`);
  if (terminal) parts.push(`执行 ${terminal} 条命令`);
  if (subagents) parts.push(`派出 ${subagents} 个子任务`);
  if (otherTools > 0) parts.push(`调用 ${otherTools} 个其他工具`);
  const headline = parts.length ? parts.join("，") : streaming && tools.length === running.length && running.length ? "正在开始" : streaming ? "进行中" : "已完成";
  const current = running.length ? running.length === 1
    ? `正在${running[0]?.name === "read" || running[0]?.name === "find" || running[0]?.name === "glob" ? "读取" : running[0]?.name === "edit" || running[0]?.name === "write" || running[0]?.name === "multiedit" ? "修改" : running[0]?.name === "grep" ? "检索" : running[0]?.name === "bash" || running[0]?.name === "powershell" ? "执行命令" : `执行 ${running[0]?.name}`}`
    : `${running.length} 项进行中` : "";
  if (!tools.length) return `过程 · ${streaming ? "思考中" : `${entries.length} 个步骤`}${failed ? ` · ${failed} 项失败` : ""}`;
  return `过程 · ${headline}${current ? ` · ${current}` : ""}${failed ? ` · ${failed} 项失败` : ""}`;
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
    // Move focus before the focused footer button is removed. Never defer this
    // focus change: a later frame may already belong to another conversation.
    details?.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
    setDisclosure(false);
    const revealSummary = () => {
      if (details?.isConnected && !details.open) details.scrollIntoView?.({ block: "nearest" });
    };
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
  // Thinking stays a collapsible process step: collapsed it shows only the bulb + "思考".
  return <PersistentDetails className="process-entry process-thinking" disclosureKey={disclosureKey}>
    <summary><LightbulbIcon className="process-thinking-icon" /><span>思考</span></summary>
    <pre>{text}</pre>
  </PersistentDetails>;
}

export const ConversationProcess = memo(function ConversationProcess({ entries, streaming = false, disclosureKey = "process", runStartedAt = null, runDurationMs = null }: { entries: ProcessEntry[]; streaming?: boolean; disclosureKey?: string; runStartedAt?: number | null; runDurationMs?: number | null }) {
  const summary = useMemo(() => summarize(entries, streaming), [entries, streaming]);
  const runDuration = useRunDuration(streaming, runStartedAt, runDurationMs);
  const hasFailures = entries.some((entry) => entry.kind === "tool" && entry.isError);
  const status = hasFailures ? <AlertIcon className="process-status-icon is-error" /> : streaming ? <span className="process-status-icon is-running" aria-hidden="true" /> : <CheckIcon className="process-status-icon" />;

  const body = <PersistentDetails className={`conversation-process${streaming ? " is-streaming" : ""}`} disclosureKey={disclosureKey} footerCollapse>
    <summary><span className="conversation-process-summary process-summary-label">{status}<span className="process-summary-title">{summary}</span></span>{runDuration && <time className="conversation-process-duration" {...(runDuration.dateTime ? { dateTime: runDuration.dateTime } : null)} title={runDuration.title}>{runDuration.label}</time>}<span className="conversation-process-chevron" aria-hidden="true"><svg className="chevron-collapsed" viewBox="0 0 16 16"><path d="M10 3.5 5.5 8 10 12.5" /></svg><svg className="chevron-expanded" viewBox="0 0 16 16"><path d="M3.5 6 8 10.5 12.5 6" /></svg></span></summary>
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
              <span className="process-tool-icon"><PencilIcon /></span>
              <span>edit</span>
              <strong>{name}</strong>
              <span className="process-edit-stats"><b>+{editDiff.additions}</b><i>-{editDiff.deletions}</i></span>
              {!completed && <em>{entry.isError ? "失败" : "执行中…"}</em>}
            </button>
            {entry.isError && entry.result && <div className="process-tool-detail"><section><strong>错误信息</strong><pre>{entry.result}</pre></section></div>}
          </div>;
        }
        const toolKey = entry.id || `tool-${index}`;
        const ToolIcon = toolPresentation(entry.name).icon;
        return <PersistentDetails className={`process-entry process-tool ${entry.isError ? "is-error" : ""}`} disclosureKey={`${disclosureKey}:${toolKey}`} key={toolKey}>
          <summary><span className="process-summary-label">{entry.isError ? <AlertIcon className="process-status-icon is-error" /> : entry.completed ? <CheckIcon className="process-status-icon" /> : <span className="process-status-icon is-running" aria-hidden="true" />}<span className="process-tool-icon"><ToolIcon /></span>{toolLabel(entry)}{toolSummaryDetail(entry) && <span className="process-tool-summary" title={toolSummary(entry)}>{toolSummaryDetail(entry)}</span>}</span></summary>
          {(entry.arguments || entry.result) && <div className="process-tool-detail">
            {entry.arguments && <section><strong>调用参数</strong><pre>{entry.arguments}</pre></section>}
            {entry.result && <section><strong>{entry.isError ? "错误信息" : "结果"}</strong><pre>{entry.result}</pre></section>}
          </div>}
        </PersistentDetails>;
      })}
    </div>
  </PersistentDetails>;
  return reactRenderBenchmarkEnabled
    ? <Profiler id="component:ConversationProcess" onRender={recordReactRenderBenchmarkCommit}>{body}</Profiler>
    : body;
});
