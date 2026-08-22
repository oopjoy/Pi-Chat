import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { WorkspaceDirectoryData, WorkspaceFileData } from "../../shared/types";
import { compactEditPath, type ToolEditDiff } from "../lib/tool-edit-diff";
import { ChevronRightIcon, FileIcon, FolderIcon, RefreshIcon } from "./Icons";

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

function joinWorkspacePath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${bytes} B`;
}

function WorkspaceFiles({ sessionId, workspacePath, visible, listDirectory, readFile }: {
  sessionId: string;
  workspacePath: string;
  visible: boolean;
  listDirectory: (sessionId: string, dir: string) => Promise<WorkspaceDirectoryData>;
  readFile: (sessionId: string, path: string, signal?: AbortSignal) => Promise<WorkspaceFileData>;
}) {
  const [levels, setLevels] = useState<Map<string, WorkspaceDirectoryData>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [directoryError, setDirectoryError] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [preview, setPreview] = useState<WorkspaceFileData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const ownerRef = useRef(sessionId);
  const workspaceGenerationRef = useRef(0);
  const pendingDirsRef = useRef(new Set<string>());
  const previewRequestRef = useRef<AbortController | null>(null);
  ownerRef.current = sessionId;

  const loadDirectory = useCallback(async (dir: string) => {
    if (!/^[a-f0-9]{20}$/.test(sessionId)) return;
    const generation = workspaceGenerationRef.current;
    const pendingKey = `${generation}\u0000${dir}`;
    if (pendingDirsRef.current.has(pendingKey)) return;
    pendingDirsRef.current.add(pendingKey);
    setLoadingDirs((current) => new Set(current).add(dir));
    setDirectoryError("");
    try {
      const result = await listDirectory(sessionId, dir);
      if (ownerRef.current !== sessionId || workspaceGenerationRef.current !== generation) return;
      setLevels((current) => new Map(current).set(dir, result));
    } catch (error) {
      if (ownerRef.current === sessionId && workspaceGenerationRef.current === generation)
        setDirectoryError(error instanceof Error ? error.message : "无法读取 Workspace 文件");
    } finally {
      pendingDirsRef.current.delete(pendingKey);
      if (ownerRef.current === sessionId && workspaceGenerationRef.current === generation) {
        setLoadingDirs((current) => {
          const next = new Set(current);
          next.delete(dir);
          return next;
        });
      }
    }
  }, [listDirectory, sessionId]);

  useEffect(() => {
    workspaceGenerationRef.current += 1;
    previewRequestRef.current?.abort();
    previewRequestRef.current = null;
    pendingDirsRef.current.clear();
    setLevels(new Map());
    setExpanded(new Set());
    setLoadingDirs(new Set());
    setDirectoryError("");
    setSelectedPath("");
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError("");
  }, [sessionId, workspacePath]);

  useEffect(() => {
    if (visible) void loadDirectory("");
  }, [loadDirectory, visible]);

  useEffect(() => () => previewRequestRef.current?.abort(), []);

  const toggleDirectory = (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(path);
      else next.delete(path);
      return next;
    });
    if (opening && !levels.has(path)) void loadDirectory(path);
  };

  const openFile = async (path: string) => {
    previewRequestRef.current?.abort();
    const request = new AbortController();
    previewRequestRef.current = request;
    setSelectedPath(path);
    setPreview(null);
    setPreviewLoading(true);
    setPreviewError("");
    try {
      const result = await readFile(sessionId, path, request.signal);
      if (previewRequestRef.current === request && ownerRef.current === sessionId) setPreview(result);
    } catch (error) {
      if (request.signal.aborted) return;
      if (previewRequestRef.current === request && ownerRef.current === sessionId)
        setPreviewError(error instanceof Error ? error.message : "无法预览文件");
    } finally {
      if (previewRequestRef.current === request) {
        previewRequestRef.current = null;
        setPreviewLoading(false);
      }
    }
  };

  const renderLevel = (dir: string, depth: number): React.ReactNode => {
    const level = levels.get(dir);
    if (!level) {
      return loadingDirs.has(dir) ? <p className="workspace-files-note" style={{ paddingLeft: `${14 + depth * 14}px` }}>正在加载…</p> : null;
    }
    if (!level.entries.length)
      return <p className="workspace-files-note" style={{ paddingLeft: `${14 + depth * 14}px` }}>空目录</p>;
    const rows = level.entries.map((entry) => {
      const path = joinWorkspacePath(dir, entry.name);
      const indent = { paddingLeft: `${8 + depth * 14}px` };
      if (entry.type === "directory") {
        const open = expanded.has(path);
        return <Fragment key={path}>
          <button type="button" className="workspace-file-row is-directory" style={indent} aria-expanded={open} title={path} onClick={() => toggleDirectory(path)}>
            <ChevronRightIcon className={open ? "is-expanded" : ""} aria-hidden="true" />
            <FolderIcon aria-hidden="true" />
            <span>{entry.name}</span>
          </button>
          {open && renderLevel(path, depth + 1)}
        </Fragment>;
      }
      return <button type="button" key={path} className={`workspace-file-row is-file${selectedPath === path ? " is-selected" : ""}`} style={indent} title={path} onClick={() => void openFile(path)}>
        <span className="workspace-file-indent" aria-hidden="true" />
        <FileIcon aria-hidden="true" />
        <span>{entry.name}</span>
      </button>;
    });
    return <>{rows}{level.truncated && <p className="workspace-files-note">目录内容较多，仅显示前 500 项。</p>}</>;
  };

  if (!/^[a-f0-9]{20}$/.test(sessionId))
    return <div className="edit-diff-sidebar-empty">新对话保存后即可浏览 Workspace 文件。</div>;

  return <div className="workspace-files-panel">
    <div className="workspace-files-toolbar">
      <strong title={workspacePath}>{workspacePath || "Workspace"}</strong>
      <button type="button" aria-label="刷新 Workspace 文件" title="刷新文件" onClick={() => {
        setLevels(new Map());
        setExpanded(new Set());
        void loadDirectory("");
      }}><RefreshIcon /></button>
    </div>
    {directoryError && <p className="workspace-files-error" role="status">{directoryError}</p>}
    <div className="workspace-files-tree" role="tree" aria-label="Workspace 文件">{renderLevel("", 0)}</div>
    <section className="workspace-file-preview" aria-label="文件预览">
      {previewLoading && <p className="workspace-files-note">正在读取 {selectedPath}…</p>}
      {previewError && <p className="workspace-files-error" role="status">{previewError}</p>}
      {!previewLoading && !previewError && !preview && <p className="workspace-files-note">选择文件即可在此只读预览。</p>}
      {preview && <>
        <header title={preview.path}><strong>{preview.path}</strong><span>{formatFileSize(preview.size)}</span></header>
        {preview.encodingLossy && <p className="workspace-files-warning">部分文本不是有效 UTF-8，已使用替代字符显示。</p>}
        <pre><code>{preview.text || " "}</code></pre>
        {preview.truncated && <p className="workspace-files-warning">文件较大，仅显示前 256 KB。</p>}
      </>}
    </section>
  </div>;
}

export function EditDiffSidebar({ open, width, sessionId, workspacePath, listWorkspaceFiles, readWorkspaceFile, onOpenChange, onWidthChange }: {
  open: boolean;
  width: number;
  sessionId: string;
  workspacePath: string;
  listWorkspaceFiles: (sessionId: string, dir: string) => Promise<WorkspaceDirectoryData>;
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
    {tab === "files" ? <WorkspaceFiles sessionId={sessionId} workspacePath={workspacePath} visible={open} listDirectory={listWorkspaceFiles} readFile={readWorkspaceFile} /> : <div className="workspace-changes-panel">
      {diff ? <>
        <header className="edit-diff-sidebar-header"><span title={diff.path}><strong>{compactEditPath(diff.path)}</strong><b>+{diff.additions}</b><i>-{diff.deletions}</i></span></header>
        <EditToolDiff diff={diff} />
      </> : <div className="edit-diff-sidebar-empty">点击对话过程中的 Edit 查看修改内容。</div>}
    </div>}
  </aside>;
}
