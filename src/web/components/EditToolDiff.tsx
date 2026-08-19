import { Fragment, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { compactEditPath, type ToolEditDiff } from "../lib/tool-edit-diff";

const OPEN_DIFF_EVENT = "pi-chat-open-edit-diff";

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

export function EditDiffSidebar({ open, width, onOpenChange, onWidthChange }: { open: boolean; width: number; onOpenChange: (open: boolean) => void; onWidthChange: (width: number) => void }) {
  const [diff, setDiff] = useState<ToolEditDiff | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const listener = (event: Event) => {
      const next = (event as CustomEvent<ToolEditDiff>).detail;
      if (!next) return;
      setDiff(next);
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

  return <aside className={`edit-diff-sidebar${open ? " is-open" : ""}`} style={{ "--edit-diff-width": `${width}px` } as CSSProperties} aria-label="文件修改对比侧栏" aria-hidden={!open} inert={!open}>
    <div className="edit-diff-sidebar-resize" role="separator" aria-label="调整 Diff 侧栏宽度" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} />
    <header className="edit-diff-sidebar-header">
      <span title={diff?.path}>{diff ? <><strong>{compactEditPath(diff.path)}</strong><b>+{diff.additions}</b><i>-{diff.deletions}</i></> : "修改对比"}</span>
      <button type="button" onClick={() => onOpenChange(false)} aria-label="收起修改对比侧栏">×</button>
    </header>
    {diff ? <EditToolDiff diff={diff} /> : <div className="edit-diff-sidebar-empty">点击过程中的 edit 查看修改内容</div>}
  </aside>;
}
