import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { WorkspaceFileData, WorkspaceRecentFilesData } from "../../shared/types";
import { compactEditPath, type ToolEditDiff } from "../lib/tool-edit-diff";
import { FileIcon, RefreshIcon } from "./Icons";

const OPEN_DIFF_EVENT = "pi-chat-open-edit-diff";

type InspectorTab = "files" | "changes";

export function openEditDiffSidebar(diff: ToolEditDiff): void {
  window.dispatchEvent(new window.CustomEvent<ToolEditDiff>(OPEN_DIFF_EVENT, { detail: diff }));
}

export function EditToolDiff({ diff }: { diff: ToolEditDiff }) {
  if (diff.sensitive) return <p className="edit-tool-diff-note">敏感文件仅显示修改摘要。</p>;
  return <div className="edit-tool-diff-body">
    {diff.hunks.map((hunk, index) => <section key={index}>
      <header>@@</header>
      <pre className="edit-tool-diff-unified">{hunk.lines.map((line, lineIndex) => <Fragment key={lineIndex}><span className={`edit-tool-diff-line is-${line.kind}`}><span className="edit-tool-diff-marker" aria-hidden="true">{line.kind === "add" ? "+" : "-"}</span><code className="edit-tool-diff-line-content">{line.text || " "}</code></span>{"\n"}</Fragment>)}</pre>
    </section>)}
    {diff.truncated && <p className="edit-tool-diff-note">Diff 过大，已截断显示。</p>}
  </div>;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${bytes} B`;
}

function WorkspaceFiles({ sessionId, workspacePath, visible, activityRevision, listRecentFiles, readFile }: {
  sessionId: string;
  workspacePath: string;
  visible: boolean;
  activityRevision: string;
  listRecentFiles: (sessionId: string, signal?: AbortSignal) => Promise<WorkspaceRecentFilesData>;
  readFile: (sessionId: string, path: string, signal?: AbortSignal) => Promise<WorkspaceFileData>;
}) {
  const [recent, setRecent] = useState<WorkspaceRecentFilesData | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [preview, setPreview] = useState<WorkspaceFileData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [listHeight, setListHeight] = useState<number | null>(null);
  const ownerRef = useRef(sessionId);
  const selectedPathRef = useRef(selectedPath);
  const workspaceGenerationRef = useRef(0);
  const recentRequestRef = useRef<AbortController | null>(null);
  const previewRequestRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const splitResizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  ownerRef.current = sessionId;
  selectedPathRef.current = selectedPath;

  const loadRecent = useCallback(async () => {
    if (!/^[a-f0-9]{20}$/.test(sessionId)) return;
    recentRequestRef.current?.abort();
    const request = new AbortController();
    const generation = workspaceGenerationRef.current;
    recentRequestRef.current = request;
    setRecentLoading(true);
    setRecentError("");
    try {
      const result = await listRecentFiles(sessionId, request.signal);
      if (recentRequestRef.current !== request || ownerRef.current !== sessionId || workspaceGenerationRef.current !== generation) return;
      setRecent(result);
      if (selectedPathRef.current && !result.files.some((file) => file.path === selectedPathRef.current)) {
        previewRequestRef.current?.abort();
        setSelectedPath("");
        setPreview(null);
        setPreviewError("");
      }
    } catch (error) {
      if (!request.signal.aborted && recentRequestRef.current === request)
        setRecentError(error instanceof Error ? error.message : "无法读取最近修改文件");
    } finally {
      if (recentRequestRef.current === request) {
        recentRequestRef.current = null;
        setRecentLoading(false);
      }
    }
  }, [listRecentFiles, sessionId]);

  useEffect(() => {
    workspaceGenerationRef.current += 1;
    recentRequestRef.current?.abort();
    previewRequestRef.current?.abort();
    recentRequestRef.current = null;
    previewRequestRef.current = null;
    setRecent(null);
    setRecentLoading(false);
    setRecentError("");
    setSelectedPath("");
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError("");
  }, [sessionId, workspacePath]);

  useEffect(() => {
    if (visible) void loadRecent();
  }, [activityRevision, loadRecent, visible]);

  useEffect(() => () => {
    recentRequestRef.current?.abort();
    previewRequestRef.current?.abort();
  }, []);

  const openFile = async (path: string) => {
    previewRequestRef.current?.abort();
    const request = new AbortController();
    const generation = workspaceGenerationRef.current;
    previewRequestRef.current = request;
    setSelectedPath(path);
    setPreview(null);
    setPreviewLoading(true);
    setPreviewError("");
    try {
      const result = await readFile(sessionId, path, request.signal);
      if (previewRequestRef.current === request && ownerRef.current === sessionId && workspaceGenerationRef.current === generation) setPreview(result);
    } catch (error) {
      if (request.signal.aborted) return;
      if (previewRequestRef.current === request && ownerRef.current === sessionId && workspaceGenerationRef.current === generation)
        setPreviewError(error instanceof Error ? error.message : "无法预览文件");
    } finally {
      if (previewRequestRef.current === request) {
        previewRequestRef.current = null;
        setPreviewLoading(false);
      }
    }
  };

  const clampListHeight = (height: number): number => {
    const panelHeight = panelRef.current?.clientHeight || 500;
    return Math.max(96, Math.min(Math.max(96, panelHeight - 96), height));
  };
  const startSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    splitResizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: listRef.current?.getBoundingClientRect().height || 180 };
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const resize = splitResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      const panelHeight = panelRef.current?.clientHeight || 500;
      const height = Math.max(96, Math.min(Math.max(96, panelHeight - 96), resize.startHeight + event.clientY - resize.startY));
      setListHeight(height);
    };
    const end = (event: PointerEvent) => {
      if (splitResizeRef.current?.pointerId === event.pointerId) splitResizeRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  if (!/^[a-f0-9]{20}$/.test(sessionId))
    return <div className="edit-diff-sidebar-empty">新对话保存后即可查看最近修改文件。</div>;

  return <div className="workspace-files-panel" ref={panelRef}>
    <div className="workspace-files-toolbar">
      <strong title={workspacePath}>最近修改</strong>
      <button type="button" aria-label="刷新最近修改文件" title="刷新文件" onClick={() => void loadRecent()}><RefreshIcon /></button>
    </div>
    {recentError && <p className="workspace-files-error" role="status">{recentError}</p>}
    <div className="workspace-files-list" ref={listRef} style={listHeight === null ? undefined : { height: `${listHeight}px`, flexBasis: `${listHeight}px` }} role="list" aria-label="当前对话最近修改的文件">
      {recentLoading && !recent && <p className="workspace-files-note">正在读取最近修改…</p>}
      {!recentLoading && recent && recent.files.length === 0 && <p className="workspace-files-note">当前对话还没有通过 Edit 或 Write 成功修改文件。</p>}
      {recent?.files.map((file) => <button type="button" role="listitem" key={file.path} className={`workspace-file-row is-file${selectedPath === file.path ? " is-selected" : ""}`} title={file.path} onClick={() => void openFile(file.path)}>
        <FileIcon aria-hidden="true" />
        <span><strong>{file.name}</strong><small>{file.path}</small></span>
        <em>{file.operation === "edit" ? "Edit" : "Write"}</em>
      </button>)}
      {recent?.truncated && <p className="workspace-files-note">仅显示最近修改的 50 个文件。</p>}
    </div>
    <div className="workspace-files-splitter" role="separator" aria-label="调整文件列表与预览高度" aria-orientation="horizontal" tabIndex={0}
      onPointerDown={startSplitResize}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const current = listRef.current?.getBoundingClientRect().height || 180;
        setListHeight(clampListHeight(current + (event.key === "ArrowDown" ? 20 : -20)));
      }}><span aria-hidden="true" /></div>
    <section className="workspace-file-preview" aria-label="文件预览">
      {previewLoading && <p className="workspace-files-note">正在读取 {selectedPath}…</p>}
      {previewError && <p className="workspace-files-error" role="status">{previewError}</p>}
      {!previewLoading && !previewError && !preview && <p className="workspace-files-note">选择最近修改的文件即可在此只读预览。</p>}
      {preview && <>
        <header title={preview.path}><strong>{preview.path}</strong><span>{formatFileSize(preview.size)}</span></header>
        <pre tabIndex={0}><code>{preview.text || " "}</code></pre>
        {preview.truncated && <p className="workspace-files-warning">文件较大，仅显示前 256 KB。</p>}
      </>}
    </section>
  </div>;
}

export function EditDiffSidebar({ open, width, sessionId, workspacePath, workspaceActivityRevision, listWorkspaceFiles, readWorkspaceFile, onOpenChange, onWidthChange }: {
  open: boolean;
  width: number;
  sessionId: string;
  workspacePath: string;
  workspaceActivityRevision: string;
  listWorkspaceFiles: (sessionId: string, signal?: AbortSignal) => Promise<WorkspaceRecentFilesData>;
  readWorkspaceFile: (sessionId: string, path: string, signal?: AbortSignal) => Promise<WorkspaceFileData>;
  onOpenChange: (open: boolean) => void;
  onWidthChange: (width: number) => void;
}) {
  const [diff, setDiff] = useState<ToolEditDiff | null>(null);
  const [tab, setTab] = useState<InspectorTab>("files");
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    setDiff(null);
    setTab("files");
  }, [sessionId]);

  useEffect(() => {
    const listener = (event: Event) => {
      const next = (event as CustomEvent<ToolEditDiff>).detail;
      if (!next) return;
      setDiff(next);
      setTab("changes");
      onOpenChange(true);
    };
    window.addEventListener(OPEN_DIFF_EVENT, listener);
    return () => window.removeEventListener(OPEN_DIFF_EVENT, listener);
  }, [onOpenChange]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const max = Math.min(760, Math.max(360, window.innerWidth - 280));
    onWidthChange(Math.max(320, Math.min(max, resize.startWidth + resize.startX - event.clientX)));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <aside className={`edit-diff-sidebar${open ? " is-open" : ""}`} style={{ "--edit-diff-width": `${width}px` } as CSSProperties} aria-label="文件与变更侧栏" aria-hidden={!open} inert={!open}>
    <div className="edit-diff-sidebar-resize" role="separator" aria-label="调整文件侧栏宽度" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} />
    <header className="workspace-inspector-header">
      <nav aria-label="文件侧栏视图">
        <button type="button" className={tab === "files" ? "is-active" : ""} aria-pressed={tab === "files"} onClick={() => setTab("files")}>Files</button>
        <button type="button" className={tab === "changes" ? "is-active" : ""} aria-pressed={tab === "changes"} onClick={() => setTab("changes")}>Changes</button>
      </nav>
      <button type="button" onClick={() => onOpenChange(false)} aria-label="收起文件与变更侧栏">×</button>
    </header>
    {tab === "files" ? <WorkspaceFiles sessionId={sessionId} workspacePath={workspacePath} visible={open} activityRevision={workspaceActivityRevision} listRecentFiles={listWorkspaceFiles} readFile={readWorkspaceFile} /> : <div className="workspace-changes-panel">
      {diff ? <>
        <header className="edit-diff-sidebar-header"><span title={diff.path}><strong>{compactEditPath(diff.path)}</strong><b>+{diff.additions}</b><i>-{diff.deletions}</i></span></header>
        <EditToolDiff diff={diff} />
      </> : <div className="edit-diff-sidebar-empty">点击对话过程中的 Edit 查看修改内容。</div>}
    </div>}
  </aside>;
}
