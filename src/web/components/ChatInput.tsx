import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import type { PromptDelivery, PromptImage, SlashCommand } from "../../shared/types";
import { CloseIcon, FileSearchIcon, ImageIcon, PaperclipIcon, SendIcon } from "./Icons";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function imageFromFile(file: File): Promise<PromptImage> {
  if (!IMAGE_TYPES.has(file.type)) return Promise.reject(new Error(`不支持图片格式：${file.name}`));
  if (file.size > MAX_IMAGE_BYTES) return Promise.reject(new Error(`图片 ${file.name} 超过 8 MB`));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      if (comma < 0) return reject(new Error(`无法读取图片：${file.name}`));
      resolve({ type: "image", data: value.slice(comma + 1), mimeType: file.type, fileName: file.name, size: file.size });
    };
    reader.readAsDataURL(file);
  });
}

export function fileReferences(paths: string[]): string {
  if (!paths.length) return "";
  return `请按需使用工具读取以下本地文件：\n${paths.map((path) => `- \`${path.replace(/`/g, "\\`")}\``).join("\n")}`;
}

export function windowsPathsFromText(text: string): string[] {
  const paths = text.split(/\r?\n/).map((line) => line.trim().replace(/^"|"$/g, "")).map((line) => {
    if (!/^file:\/\//i.test(line)) return line;
    try { return decodeURIComponent(new URL(line).pathname).replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\"); }
    catch { return ""; }
  }).filter((line) => /^[A-Za-z]:[\\/]/.test(line));
  return [...new Set(paths)];
}

function subsequenceScore(name: string, query: string): number | null {
  let position = 0;
  let first = -1;
  let gaps = 0;
  for (const character of query) {
    const found = name.indexOf(character, position);
    if (found < 0) return null;
    if (first >= 0) gaps += found - position;
    else first = found;
    position = found + 1;
  }
  // Earlier and tighter ordered matches rank ahead of looser ones.
  return first * 100 + gaps;
}

export function commandMatches(value: string, commands: SlashCommand[]): SlashCommand[] {
  if (!value.startsWith("/") || value.includes("\n") || /^\/\S+\s/.test(value)) return [];
  const token = value.slice(1).split(/\s/, 1)[0].toLowerCase();
  return commands.flatMap((command) => {
    const name = command.name.toLowerCase();
    const score = subsequenceScore(name, token);
    return score === null ? [] : [{ command, score, rank: name === token ? 0 : name.startsWith(token) ? 1 : 2 }];
  }).sort((a, b) => a.rank - b.rank || a.score - b.score || a.command.name.localeCompare(b.command.name)).slice(0, 9).map(({ command }) => command);
}

export function ChatInput({ streaming, activelyStreaming = streaming, stopping, disabled, disabledPlaceholder, placeholder, acceptsImages, imageInputPending = false, imageInputPendingMessage = "模型图片能力尚未确认", resolveImageCapabilityOnSend = false, restoredDraft, onDraftRevisionChange, commands, controls, notices, onSend, onAbort, onPickLocalFiles, onReadClipboardFiles, onError }: {
  /** True when a submission will enter the local queue. */
  streaming: boolean;
  /** True only while Pi is actively generating and can be stopped. */
  activelyStreaming?: boolean;
  stopping: boolean;
  disabled: boolean;
  disabledPlaceholder?: string;
  placeholder?: string;
  acceptsImages: boolean;
  /** The selected model is provisional until the current Runtime confirms it. */
  imageInputPending?: boolean;
  /** Explains whether preparation, metadata synchronization, or recovery owns the wait. */
  imageInputPendingMessage?: string;
  /** A cold/draft send can prepare its Runtime before validating image support. */
  resolveImageCapabilityOnSend?: boolean;
  /** A cancelled queued prompt replaces the current Composer draft. */
  restoredDraft?: { revision: number; expectedDraftRevision: number; message: string; images: PromptImage[] } | null;
  onDraftRevisionChange?: (revision: number) => void;
  commands: SlashCommand[];
  controls?: ReactNode;
  /** System status sits immediately above the actual Composer, never over its input. */
  notices?: ReactNode;
  onSend: (message: string, images: PromptImage[], delivery?: PromptDelivery) => Promise<void>;
  onAbort: () => Promise<void>;
  onPickLocalFiles: () => Promise<string[]>;
  onReadClipboardFiles: () => Promise<string[]>;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<PromptImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [pickingFiles, setPickingFiles] = useState(false);
  const [sending, setSending] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<HTMLDivElement>(null);
  const suggestions = useMemo(() => commandMatches(value, commands), [commands, value]);
  const invokedCommand = value.startsWith("/") ? commands.find((command) => command.name === value.slice(1).split(/\s/, 1)[0]) : undefined;
  const isExtensionCommand = invokedCommand?.source === "extension";
  const restoredDraftRef = useRef(restoredDraft);
  const draftRevisionRef = useRef(0);
  const advanceUserDraftRevision = () => {
    draftRevisionRef.current += 1;
    onDraftRevisionChange?.(draftRevisionRef.current);
  };

  useEffect(() => {
    if (!restoredDraft || restoredDraft === restoredDraftRef.current) return;
    restoredDraftRef.current = restoredDraft;
    if (draftRevisionRef.current !== restoredDraft.expectedDraftRevision) return;
    setValue(restoredDraft.message);
    setImages(restoredDraft.images);
    setSuggestionIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [restoredDraft]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = Number.parseFloat(textarea.ownerDocument.defaultView?.getComputedStyle(textarea).maxHeight || "") || 115;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = "auto";
    setSuggestionIndex((current) => Math.min(current, Math.max(0, suggestions.length - 1)));
  }, [suggestions.length, value]);

  useEffect(() => {
    // Pi may emit agent_start before the prompt HTTP response returns. At that
    // point the first turn is accepted and follow-ups can safely enter Queue.
    if (activelyStreaming) setSending(false);
  }, [activelyStreaming]);

  useEffect(() => {
    if (disabled) {
      setAttachmentOpen(false);
      setDragging(false);
      return;
    }
    if (!attachmentOpen) return;
    const close = (event: PointerEvent) => {
      if (!attachmentRef.current?.contains(event.target as Node)) setAttachmentOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [attachmentOpen, disabled]);

  const addImages = async (files: File[]) => {
    if (disabled) return;
    const candidates = files.filter((file) => file.type.startsWith("image/"));
    if (!candidates.length) return;
    if (images.length + candidates.length > MAX_IMAGES) return onError(`一次最多添加 ${MAX_IMAGES} 张图片`);
    advanceUserDraftRevision();
    try {
      const added = await Promise.all(candidates.map(imageFromFile));
      setImages((current) => [...current, ...added]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const completeCommand = (command: SlashCommand) => {
    setValue(`/${command.name} `);
    setSuggestionIndex(0);
    advanceUserDraftRevision();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submit = async (delivery: PromptDelivery = "queue") => {
    const message = value.trim();
    if ((!message && !images.length) || disabled || sending) return;
    if (delivery === "steer" && message.startsWith("/")) {
      onError("Slash 指令不能作为 Steer 消息发送");
      return;
    }
    if (
      images.length &&
      !resolveImageCapabilityOnSend &&
      (imageInputPending || !acceptsImages)
    ) {
      onError(
        imageInputPending
          ? imageInputPendingMessage
          : "当前模型不支持图片输入",
      );
      return;
    }
    const pendingImages = images;
    setSending(true);
    setValue("");
    setImages([]);
    advanceUserDraftRevision();
    try {
      await onSend(message, pendingImages, delivery);
    } catch {
      setValue(message);
      setImages(pendingImages);
    } finally {
      setSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setSuggestionIndex((index) => (index + 1) % suggestions.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length); return; }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && `/${suggestions[suggestionIndex].name}` !== value)) { event.preventDefault(); completeCommand(suggestions[suggestionIndex]); return; }
      if (event.key === "Escape") { event.preventDefault(); setValue((current) => current === "/" ? "" : current); advanceUserDraftRevision(); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const appendFileReferences = (paths: string[]) => {
    if (disabled) return;
    const references = fileReferences(paths);
    if (references) {
      setValue((current) => current.trim() ? `${current.trimEnd()}\n\n${references}` : references);
      advanceUserDraftRevision();
    }
  };

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardFiles = [...event.clipboardData.items].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    const imageFiles = clipboardFiles.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length) {
      event.preventDefault();
      void addImages(imageFiles);
      return;
    }
    const clipboardText = event.clipboardData.getData("text/uri-list") || event.clipboardData.getData("text/plain");
    const textPaths = windowsPathsFromText(clipboardText);
    const clipboardLines = clipboardText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    if (textPaths.length && textPaths.length === clipboardLines.length) {
      event.preventDefault();
      appendFileReferences(textPaths);
      return;
    }
    if (clipboardFiles.length || event.clipboardData.types.includes("Files")) {
      event.preventDefault();
      advanceUserDraftRevision();
      void onReadClipboardFiles().then((paths) => {
        if (paths.length) appendFileReferences(paths);
        else onError("无法取得文件的本地路径，请使用发送按钮旁的附件按钮选择本地文件");
      }).catch((error) => onError(error instanceof Error ? error.message : String(error)));
    }
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const files = [...event.dataTransfer.files];
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const ordinaryFiles = files.filter((file) => !file.type.startsWith("image/"));
    if (imageFiles.length) void addImages(imageFiles);
    if (ordinaryFiles.length) {
      const directPaths = ordinaryFiles.map((file) => (file as File & { path?: string }).path || "").filter(Boolean);
      const transferredPaths = windowsPathsFromText(event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"));
      const paths = [...new Set([...directPaths, ...transferredPaths])];
      if (paths.length) appendFileReferences(paths);
      else onError("浏览器未提供文件的绝对路径，请使用发送按钮旁的附件按钮选择本地文件");
    }
  };

  const pickFiles = async () => {
    if (disabled) return;
    setAttachmentOpen(false);
    setPickingFiles(true);
    advanceUserDraftRevision();
    try {
      const paths = await onPickLocalFiles();
      appendFileReferences(paths);
      textareaRef.current?.focus();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPickingFiles(false);
    }
  };

  return (
    <div className="composer-wrap">
      {notices && <div className="system-notice-stack" aria-live="polite">{notices}</div>}
      <div className={`composer ${dragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop}>
        {!disabled && suggestions.length > 0 && <div className="command-suggestions" role="listbox" aria-label="Pi 指令联想">{suggestions.map((command, index) => <button type="button" role="option" aria-selected={index === suggestionIndex} className={index === suggestionIndex ? "is-active" : ""} key={`${command.source}-${command.name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => completeCommand(command)}><strong>/{command.name}</strong><span>{command.description || "Pi 指令"}</span><small>{command.source}</small></button>)}</div>}
        {images.length > 0 && <div className="image-previews">{images.map((image, index) => <div className="image-preview" key={`${image.fileName}-${index}`}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.fileName || `图片 ${index + 1}`} /><button type="button" disabled={disabled} onClick={() => { setImages((current) => current.filter((_, itemIndex) => itemIndex !== index)); advanceUserDraftRevision(); }} aria-label={`移除 ${image.fileName || "图片"}`}><CloseIcon /></button><small>{image.fileName || "粘贴的图片"}</small></div>)}</div>}
        <textarea ref={textareaRef} value={value} onChange={(event) => { setValue(event.target.value); advanceUserDraftRevision(); }} onPaste={paste} onKeyDown={keyDown} disabled={disabled} rows={1} placeholder={disabled ? disabledPlaceholder || "正在切换会话…" : placeholder || (streaming ? "继续输入，发送后加入队列；输入 / 查看指令" : "输入消息，或粘贴、拖入附件")} aria-label="消息输入" />
        <div className="composer-toolbar">
          <div className="composer-toolbar-controls">{controls}</div>
          <div className="composer-actions">
            {streaming && <button type="button" className="queue-submit-button" disabled={(!value.trim() && !images.length) || disabled || sending || stopping} onClick={() => void submit("queue")}>{sending ? (isExtensionCommand ? "执行中…" : "排队中…") : isExtensionCommand ? "执行" : "排队"}</button>}
            {activelyStreaming && !value.trimStart().startsWith("/") && <button type="button" className="steer-submit-button" disabled={(!value.trim() && !images.length) || disabled || sending || stopping} onClick={() => void submit("steer")} title="在当前 assistant turn 的工具调用结束后、下一次模型调用前优先送达">Steer</button>}
            <div className="attachment-control" ref={attachmentRef}>
              <button type="button" className={`attachment-button ${attachmentOpen ? "is-open" : ""}`} disabled={disabled || pickingFiles} onClick={() => setAttachmentOpen((open) => !open)} title="添加附件" aria-label="添加附件" aria-haspopup="menu" aria-expanded={attachmentOpen}><PaperclipIcon /></button>
              {attachmentOpen && <div className="attachment-menu" role="menu">
                <button type="button" role="menuitem" disabled={images.length >= MAX_IMAGES} onClick={() => { setAttachmentOpen(false); advanceUserDraftRevision(); imageInputRef.current?.click(); }}><ImageIcon className="attachment-menu-icon" /><strong>图片</strong><small>{resolveImageCapabilityOnSend ? "可添加；发送时准备 Runtime 并检查支持" : imageInputPending ? "可添加；发送前等待模型能力同步" : acceptsImages ? "直接解析，可粘贴或拖入" : "可添加；发送时检查模型支持"}</small></button>
                <button type="button" role="menuitem" disabled={pickingFiles} onClick={() => void pickFiles()}><FileSearchIcon className="attachment-menu-icon" /><strong>{pickingFiles ? "选择中…" : "本地文件"}</strong><small>引用 Windows 绝对路径</small></button>
              </div>}
              <input ref={imageInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void addImages([...event.target.files || []]); event.target.value = ""; }} />
            </div>
            {activelyStreaming
              ? <button type="button" className="stop-button" disabled={disabled || stopping} onClick={() => void onAbort()} aria-label={stopping ? "正在停止" : "停止生成"} title={stopping ? "正在停止" : "停止生成"}><span aria-hidden="true" /></button>
              : !streaming && <button type="button" className="send-button" disabled={(!value.trim() && !images.length) || disabled || sending || stopping} onClick={() => void submit()} aria-label={sending ? "正在发送" : isExtensionCommand ? "执行指令" : "发送消息"} title={sending ? "正在发送" : isExtensionCommand ? "执行指令" : "发送消息"}><SendIcon /></button>}
          </div>
        </div>
        {dragging && <div className="drop-hint">松开以添加附件</div>}
      </div>
    </div>
  );
}
