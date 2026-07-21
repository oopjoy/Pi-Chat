import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { PromptImage, SlashCommand } from "../../shared/types";
import { CloseIcon, FileSearchIcon, ImageIcon, PlusIcon } from "./Icons";

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

export function ChatInput({ streaming, stopping, disabled, disabledPlaceholder, acceptsImages, commands, onSend, onAbort, onPickLocalFiles, onReadClipboardFiles, onError }: {
  streaming: boolean;
  stopping: boolean;
  disabled: boolean;
  disabledPlaceholder?: string;
  acceptsImages: boolean;
  commands: SlashCommand[];
  onSend: (message: string, images: PromptImage[]) => Promise<void>;
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

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    setSuggestionIndex((current) => Math.min(current, Math.max(0, suggestions.length - 1)));
  }, [suggestions.length, value]);

  useEffect(() => {
    if (!attachmentOpen) return;
    const close = (event: PointerEvent) => {
      if (!attachmentRef.current?.contains(event.target as Node)) setAttachmentOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [attachmentOpen]);

  const addImages = async (files: File[]) => {
    if (!acceptsImages) return onError("当前模型不支持图片输入");
    const candidates = files.filter((file) => file.type.startsWith("image/"));
    if (!candidates.length) return;
    if (images.length + candidates.length > MAX_IMAGES) return onError(`一次最多添加 ${MAX_IMAGES} 张图片`);
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
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submit = async () => {
    const message = value.trim();
    if ((!message && !images.length) || disabled || sending) return;
    const pendingImages = images;
    setSending(true);
    setValue("");
    setImages([]);
    try {
      await onSend(message, pendingImages);
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
      if (event.key === "Escape") { event.preventDefault(); setValue((current) => current === "/" ? "" : current); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const appendFileReferences = (paths: string[]) => {
    const references = fileReferences(paths);
    if (references) setValue((current) => current.trim() ? `${current.trimEnd()}\n\n${references}` : references);
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
      void onReadClipboardFiles().then((paths) => {
        if (paths.length) appendFileReferences(paths);
        else onError("无法取得文件的本地路径，请使用发送按钮旁的“＋”选择本地文件");
      }).catch((error) => onError(error instanceof Error ? error.message : String(error)));
    }
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const ordinaryFiles = files.filter((file) => !file.type.startsWith("image/"));
    if (imageFiles.length) void addImages(imageFiles);
    if (ordinaryFiles.length) {
      const directPaths = ordinaryFiles.map((file) => (file as File & { path?: string }).path || "").filter(Boolean);
      const transferredPaths = windowsPathsFromText(event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"));
      const paths = [...new Set([...directPaths, ...transferredPaths])];
      if (paths.length) appendFileReferences(paths);
      else onError("浏览器未提供文件的绝对路径，请使用发送按钮旁的“＋”选择本地文件");
    }
  };

  const pickFiles = async () => {
    setAttachmentOpen(false);
    setPickingFiles(true);
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
      <div className={`composer ${dragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop}>
        {suggestions.length > 0 && <div className="command-suggestions" role="listbox" aria-label="Pi 指令联想">{suggestions.map((command, index) => <button type="button" role="option" aria-selected={index === suggestionIndex} className={index === suggestionIndex ? "is-active" : ""} key={`${command.source}-${command.name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => completeCommand(command)}><strong>/{command.name}</strong><span>{command.description || "Pi 指令"}</span><small>{command.source}</small></button>)}</div>}
        {images.length > 0 && <div className="image-previews">{images.map((image, index) => <div className="image-preview" key={`${image.fileName}-${index}`}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.fileName || `图片 ${index + 1}`} /><button type="button" onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除 ${image.fileName || "图片"}`}><CloseIcon /></button><small>{image.fileName || "粘贴的图片"}</small></div>)}</div>}
        <div className="composer-main">
          <textarea ref={textareaRef} value={value} onChange={(event) => setValue(event.target.value)} onPaste={paste} onKeyDown={keyDown} disabled={disabled} rows={1} placeholder={disabled ? disabledPlaceholder || "正在切换会话…" : streaming ? "继续输入，发送后加入队列；输入 / 查看指令" : "输入消息，或粘贴、拖入附件"} aria-label="消息输入" />
          {(streaming || stopping) && <button type="button" className="stop-button" disabled={stopping} onClick={() => void onAbort()}>{stopping ? "停止中…" : "停止"}</button>}
          <div className="attachment-control" ref={attachmentRef}>
            <button type="button" className={`attachment-button ${attachmentOpen ? "is-open" : ""}`} disabled={disabled || pickingFiles} onClick={() => setAttachmentOpen((open) => !open)} title="添加附件" aria-label="添加附件" aria-haspopup="menu" aria-expanded={attachmentOpen}><PlusIcon /></button>
            {attachmentOpen && <div className="attachment-menu" role="menu">
              <button type="button" role="menuitem" disabled={!acceptsImages || images.length >= MAX_IMAGES} onClick={() => { setAttachmentOpen(false); imageInputRef.current?.click(); }}><ImageIcon className="attachment-menu-icon" /><strong>图片</strong><small>{acceptsImages ? "直接解析，可粘贴或拖入" : "当前模型不支持图片"}</small></button>
              <button type="button" role="menuitem" disabled={pickingFiles} onClick={() => void pickFiles()}><FileSearchIcon className="attachment-menu-icon" /><strong>{pickingFiles ? "选择中…" : "本地文件"}</strong><small>引用 Windows 绝对路径</small></button>
            </div>}
            <input ref={imageInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void addImages([...event.target.files || []]); event.target.value = ""; }} />
          </div>
          <button type="button" className="send-button" disabled={(!value.trim() && !images.length) || disabled || sending || stopping} onClick={() => void submit()}>{sending ? "发送中…" : isExtensionCommand ? "执行" : streaming ? "排队" : "发送"}</button>
        </div>
        {dragging && <div className="drop-hint">松开以添加附件</div>}
      </div>
    </div>
  );
}
