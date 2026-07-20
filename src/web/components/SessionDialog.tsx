import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/types";

export type SessionDialogState = { mode: "rename" | "delete"; session: SessionSummary } | null;

export function SessionDialog({ state, busy, onClose, onRename, onDelete }: {
  state: SessionDialogState;
  busy: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setName(state?.session.name || "");
    if (state?.mode === "rename") requestAnimationFrame(() => inputRef.current?.select());
  }, [state]);
  useEffect(() => {
    if (!state) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [busy, onClose, state]);
  if (!state) return null;
  const submitRename = () => {
    const value = name.trim();
    if (value && !busy) onRename(value);
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="dialog session-dialog" role="dialog" aria-modal="true" aria-labelledby="session-dialog-title">
      {state.mode === "rename" ? <>
        <h2 id="session-dialog-title">重命名对话</h2>
        <p>输入新的对话名称。按 Enter 确认，按 Esc 取消。</p>
        <input
          ref={inputRef}
          autoFocus
          value={name}
          maxLength={120}
          disabled={busy}
          aria-label="对话名称"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submitRename();
            }
          }}
        />
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="primary" disabled={busy || !name.trim()} onClick={submitRename}>{busy ? "保存中…" : "确认"}</button>
        </footer>
      </> : <>
        <h2 id="session-dialog-title">删除对话</h2>
        <p>确定删除“<strong>{state.session.name}</strong>”吗？此操作会删除本地 Session 文件，无法撤销。</p>
        {state.session.running && <p className="dialog-warning">该对话正在生成，请先停止后再删除。</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="danger" disabled={busy || state.session.running} onClick={onDelete}>{busy ? "删除中…" : "确认删除"}</button>
        </footer>
      </>}
    </section>
  </div>;
}
