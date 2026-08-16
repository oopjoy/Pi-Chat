import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGES_TOTAL_BYTES,
} from "../../shared/rpc-contracts";
import type { PromptDelivery, PromptImage, SlashCommand } from "../../shared/types";
import { CloseIcon, FileSearchIcon, ImageIcon, PaperclipIcon, SendIcon } from "./Icons";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type PendingSubmission = {
  scope: string;
  /** Immutable normal-session target captured when the editor accepts this snapshot. */
  targetSessionId?: string;
  /** Last observed control-event version for that immutable target. */
  controlVersion?: number;
  message: string;
  images: PromptImage[];
  delivery: PromptDelivery;
};

type SuspendedDraft = { message: string; images: PromptImage[] };

export function promptImageByteLength(image: Pick<PromptImage, "data" | "size">): number {
  const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
  const encodedBytes = Math.max(0, Math.floor(image.data.length * 3 / 4) - padding);
  const declaredBytes = typeof image.size === "number" && Number.isFinite(image.size)
    ? Math.max(0, Math.floor(image.size))
    : 0;
  return Math.max(encodedBytes, declaredBytes);
}

export function promptImagesByteLength(images: Array<Pick<PromptImage, "data" | "size">>): number {
  return images.reduce((total, image) => total + promptImageByteLength(image), 0);
}

export function promptImageAdditionError(
  images: Array<Pick<PromptImage, "data" | "size">>,
  candidates: Array<{ name?: string; size: number }>,
): string | null {
  if (images.length + candidates.length > MAX_PROMPT_IMAGES)
    return `一次最多添加 ${MAX_PROMPT_IMAGES} 张图片`;
  const oversized = candidates.find((file) => file.size > MAX_PROMPT_IMAGE_BYTES);
  if (oversized) return `图片 ${oversized.name || "未命名图片"} 超过 8 MB`;
  const candidateBytes = candidates.reduce(
    (total, file) => total + Math.max(0, Math.floor(file.size)),
    0,
  );
  if (promptImagesByteLength(images) + candidateBytes > MAX_PROMPT_IMAGES_TOTAL_BYTES)
    return "图片总大小不能超过 40 MB";
  return null;
}

function imageFromFile(file: File): Promise<PromptImage> {
  if (!IMAGE_TYPES.has(file.type)) return Promise.reject(new Error(`不支持图片格式：${file.name}`));
  if (file.size > MAX_PROMPT_IMAGE_BYTES) return Promise.reject(new Error(`图片 ${file.name} 超过 8 MB`));
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

export function ChatInput({ streaming, activelyStreaming = streaming, stopping, disabled, disabledPlaceholder, placeholder, acceptsImages, imageInputPending = false, imageInputPendingMessage = "模型图片能力尚未确认", resolveImageCapabilityOnSend = false, restoredDraft, onDraftRevisionChange, submissionScope, submissionTargetSessionId, submissionControlVersion, allowFollowupSubmissions = true, submissionPaused = false, submissionPausedMessage = "消息已保存，等待发送条件恢复", onSubmissionPendingChange, onSubmissionDeferred, commands, controls, notices, onSend, onAbort, onPickLocalFiles, onReadClipboardFiles, onError }: {
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
  /** Stable pane identity used only to pause editor-owned submissions during navigation. */
  submissionScope: string;
  /** Immutable normal-session prompt target, never inferred again after navigation. */
  submissionTargetSessionId?: string;
  /** Control-event version captured with the immutable target. */
  submissionControlVersion?: number;
  /** A materialized Session can accept another editor snapshot while one is pending. */
  allowFollowupSubmissions?: boolean;
  /** Keeps accepted editor snapshots local until their target may be submitted. */
  submissionPaused?: boolean;
  /** Explains why an accepted snapshot is waiting without disabling editing. */
  submissionPausedMessage?: string;
  onSubmissionPendingChange?: (scope: string, count: number) => void;
  /** A retryable admission conflict keeps its snapshot queued without retrying in a loop. */
  onSubmissionDeferred?: (error: unknown, submission: Readonly<PendingSubmission>) => boolean;
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
  const [, setSubmissionRevision] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef("");
  const imagesRef = useRef<PromptImage[]>([]);
  const currentScopeRef = useRef(submissionScope);
  const mutationDisabledRef = useRef(disabled);
  const submissionPausedRef = useRef(submissionPaused);
  const onSendRef = useRef(onSend);
  const onSubmissionDeferredRef = useRef(onSubmissionDeferred);
  const pendingByScopeRef = useRef(new Map<string, number>());
  const submissionQueueRef = useRef<PendingSubmission[]>([]);
  const drainingRef = useRef(false);
  const blockedScopesRef = useRef(new Set<string>());
  const failedSubmissionsRef = useRef(new Map<string, PendingSubmission>());
  const suspendedDraftsRef = useRef(new Map<string, SuspendedDraft>());
  const mountedRef = useRef(true);
  const suggestions = useMemo(() => commandMatches(value, commands), [commands, value]);
  const invokedCommand = value.startsWith("/") ? commands.find((command) => command.name === value.slice(1).split(/\s/, 1)[0]) : undefined;
  const isExtensionCommand = invokedCommand?.source === "extension";
  const restoredDraftRef = useRef(restoredDraft);
  const draftRevisionRef = useRef(0);
  currentScopeRef.current = submissionScope;
  mutationDisabledRef.current = disabled;
  submissionPausedRef.current = submissionPaused;
  onSendRef.current = onSend;
  onSubmissionDeferredRef.current = onSubmissionDeferred;
  const advanceUserDraftRevision = () => {
    draftRevisionRef.current += 1;
    onDraftRevisionChange?.(draftRevisionRef.current);
  };

  useEffect(() => {
    if (!restoredDraft || restoredDraft === restoredDraftRef.current) return;
    restoredDraftRef.current = restoredDraft;
    if (draftRevisionRef.current !== restoredDraft.expectedDraftRevision) return;
    valueRef.current = restoredDraft.message;
    imagesRef.current = restoredDraft.images;
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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // Navigation pauses undrained editor snapshots for the old pane. Returning
    // to that pane, regaining mutation authority, or losing a local send pause
    // resumes them with the newest App callback and committed scope.
    void drainSubmissions();
  }, [submissionScope, disabled, submissionPaused]);

  const currentPendingSubmissions = pendingByScopeRef.current.get(submissionScope) || 0;
  const submissionLocked = !allowFollowupSubmissions && currentPendingSubmissions > 0;
  const editorDisabled = disabled || submissionLocked;
  const imageAttachmentLimitReached =
    images.length >= MAX_PROMPT_IMAGES ||
    promptImagesByteLength(images) >= MAX_PROMPT_IMAGES_TOTAL_BYTES;

  useEffect(() => {
    if (editorDisabled) {
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
  }, [attachmentOpen, editorDisabled]);

  const addImages = async (files: File[]) => {
    if (editorDisabled) return;
    const candidates = files.filter((file) => file.type.startsWith("image/"));
    if (!candidates.length) return;
    const preflightError = promptImageAdditionError(imagesRef.current, candidates);
    if (preflightError) return onError(preflightError);
    try {
      const added = await Promise.all(candidates.map(imageFromFile));
      // FileReader completions may overlap across paste/drop/picker events. Recheck
      // against the latest committed attachment set so count and byte caps remain
      // atomic without introducing a second draft or upload authority.
      const commitError = promptImageAdditionError(
        imagesRef.current,
        added.map((image) => ({
          name: image.fileName,
          size: promptImageByteLength(image),
        })),
      );
      if (commitError) return onError(commitError);
      const next = [...imagesRef.current, ...added];
      imagesRef.current = next;
      setImages(next);
      advanceUserDraftRevision();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const completeCommand = (command: SlashCommand) => {
    const next = `/${command.name} `;
    valueRef.current = next;
    setValue(next);
    setSuggestionIndex(0);
    advanceUserDraftRevision();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const updatePendingScope = (scope: string, delta: number) => {
    const next = Math.max(0, (pendingByScopeRef.current.get(scope) || 0) + delta);
    if (next) pendingByScopeRef.current.set(scope, next);
    else pendingByScopeRef.current.delete(scope);
    onSubmissionPendingChange?.(scope, next);
    if (mountedRef.current) setSubmissionRevision((revision) => revision + 1);
  };

  const replaceDraft = (message: string, nextImages: PromptImage[]) => {
    valueRef.current = message;
    imagesRef.current = nextImages;
    if (mountedRef.current) {
      setValue(message);
      setImages(nextImages);
      setSuggestionIndex(0);
    }
  };

  function restoreFailedSubmission(scope: string) {
    const failed = failedSubmissionsRef.current.get(scope);
    if (!failed || currentScopeRef.current !== scope) return;
    if (
      !suspendedDraftsRef.current.has(scope) &&
      (valueRef.current.trim() || imagesRef.current.length)
    )
      suspendedDraftsRef.current.set(scope, {
        message: valueRef.current,
        images: imagesRef.current,
      });
    replaceDraft(failed.message, failed.images);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  const restoreSuspendedDraft = (scope: string) => {
    const suspended = suspendedDraftsRef.current.get(scope);
    if (
      !suspended ||
      currentScopeRef.current !== scope ||
      valueRef.current.trim() ||
      imagesRef.current.length ||
      (pendingByScopeRef.current.get(scope) || 0) > 0 ||
      blockedScopesRef.current.has(scope)
    )
      return;
    suspendedDraftsRef.current.delete(scope);
    replaceDraft(suspended.message, suspended.images);
  };

  function drainSubmissions() {
    if (drainingRef.current || mutationDisabledRef.current || submissionPausedRef.current) return;
    const scope = currentScopeRef.current;
    if (blockedScopesRef.current.has(scope)) {
      restoreFailedSubmission(scope);
      return;
    }
    const index = submissionQueueRef.current.findIndex(
      (submission) => submission.scope === scope,
    );
    if (index < 0) {
      restoreSuspendedDraft(scope);
      return;
    }
    const [submission] = submissionQueueRef.current.splice(index, 1);
    drainingRef.current = true;
    let deferred = false;
    void onSendRef.current(submission.message, submission.images, submission.delivery)
      .catch((error) => {
        deferred = onSubmissionDeferredRef.current?.(error, submission) === true;
        if (deferred) {
          submissionQueueRef.current.unshift(submission);
          return;
        }
        failedSubmissionsRef.current.set(submission.scope, submission);
        blockedScopesRef.current.add(submission.scope);
        restoreFailedSubmission(submission.scope);
      })
      .finally(() => {
        if (!deferred) updatePendingScope(submission.scope, -1);
        drainingRef.current = false;
        if (!mountedRef.current) return;
        // The defer callback schedules an App-owned pause. Do not immediately
        // retry into the same foreign-controller race before that prop arrives.
        if (deferred) {
          requestAnimationFrame(() => textareaRef.current?.focus());
          return;
        }
        if (!blockedScopesRef.current.has(currentScopeRef.current))
          drainSubmissions();
        else restoreFailedSubmission(currentScopeRef.current);
        requestAnimationFrame(() => textareaRef.current?.focus());
      });
  }

  const submit = (delivery: PromptDelivery = "queue") => {
    const message = valueRef.current.trim();
    const currentImages = imagesRef.current;
    const scope = currentScopeRef.current;
    if (
      (!message && !currentImages.length) ||
      disabled ||
      (!allowFollowupSubmissions &&
        (pendingByScopeRef.current.get(scope) || 0) > 0)
    )
      return;
    if (delivery === "steer" && message.startsWith("/")) {
      onError("Slash 指令不能作为 Steer 消息发送");
      return;
    }
    if (
      currentImages.length &&
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
    const retryingFailedSubmission =
      blockedScopesRef.current.has(scope) &&
      failedSubmissionsRef.current.has(scope);
    if (retryingFailedSubmission) {
      blockedScopesRef.current.delete(scope);
      failedSubmissionsRef.current.delete(scope);
    }
    const submission: PendingSubmission = {
      scope,
      ...(submissionTargetSessionId
        ? { targetSessionId: submissionTargetSessionId }
        : null),
      ...(typeof submissionControlVersion === "number"
        ? { controlVersion: submissionControlVersion }
        : null),
      message,
      images: currentImages,
      delivery,
    };
    if (retryingFailedSubmission) submissionQueueRef.current.unshift(submission);
    else submissionQueueRef.current.push(submission);
    replaceDraft("", []);
    advanceUserDraftRevision();
    updatePendingScope(scope, 1);
    drainSubmissions();
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setSuggestionIndex((index) => (index + 1) % suggestions.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length); return; }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && `/${suggestions[suggestionIndex].name}` !== value)) { event.preventDefault(); completeCommand(suggestions[suggestionIndex]); return; }
      if (event.key === "Escape") { event.preventDefault(); const next = valueRef.current === "/" ? "" : valueRef.current; valueRef.current = next; setValue(next); advanceUserDraftRevision(); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const appendFileReferences = (paths: string[]) => {
    if (editorDisabled) return;
    const references = fileReferences(paths);
    if (references) {
      const next = valueRef.current.trim() ? `${valueRef.current.trimEnd()}\n\n${references}` : references;
      valueRef.current = next;
      setValue(next);
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
    if (editorDisabled) return;
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
    if (editorDisabled) return;
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
      {currentPendingSubmissions > 0 && submissionPaused && <div className="composer-submission-status" role="status">{submissionPausedMessage}</div>}
      <div className={`composer ${dragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); if (!editorDisabled) setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop}>
        {!editorDisabled && suggestions.length > 0 && <div className="command-suggestions" role="listbox" aria-label="Pi 指令联想">{suggestions.map((command, index) => <button type="button" role="option" aria-selected={index === suggestionIndex} className={index === suggestionIndex ? "is-active" : ""} key={`${command.source}-${command.name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => completeCommand(command)}><strong>/{command.name}</strong><span>{command.description || "Pi 指令"}</span><small>{command.source}</small></button>)}</div>}
        {images.length > 0 && <div className="image-previews">{images.map((image, index) => <div className="image-preview" key={`${image.fileName}-${index}`}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.fileName || `图片 ${index + 1}`} /><button type="button" disabled={editorDisabled} onClick={() => { const next = imagesRef.current.filter((_, itemIndex) => itemIndex !== index); imagesRef.current = next; setImages(next); advanceUserDraftRevision(); }} aria-label={`移除 ${image.fileName || "图片"}`}><CloseIcon /></button><small>{image.fileName || "粘贴的图片"}</small></div>)}</div>}
        <textarea ref={textareaRef} value={value} onChange={(event) => { valueRef.current = event.target.value; setValue(event.target.value); advanceUserDraftRevision(); }} onPaste={paste} onKeyDown={keyDown} disabled={editorDisabled} rows={1} placeholder={editorDisabled ? disabledPlaceholder || "输入消息，或粘贴、拖入附件" : placeholder || (streaming ? "继续输入，发送后加入队列；输入 / 查看指令" : "输入消息，或粘贴、拖入附件")} aria-label="消息输入" />
        <div className="composer-toolbar">
          <div className="composer-toolbar-controls">{controls}</div>
          <div className="composer-actions">
            {streaming && <button type="button" className="queue-submit-button" disabled={(!value.trim() && !images.length) || editorDisabled || stopping} onClick={() => submit("queue")}>{isExtensionCommand ? "执行" : "排队"}</button>}
            {activelyStreaming && !value.trimStart().startsWith("/") && <button type="button" className="steer-submit-button" disabled={(!value.trim() && !images.length) || editorDisabled || stopping} onClick={() => submit("steer")} title="在当前 assistant turn 的工具调用结束后、下一次模型调用前优先送达">Steer</button>}
            <div className="attachment-control" ref={attachmentRef}>
              <button type="button" className={`attachment-button ${attachmentOpen ? "is-open" : ""}`} disabled={editorDisabled || pickingFiles} onClick={() => setAttachmentOpen((open) => !open)} title="添加附件" aria-label="添加附件" aria-haspopup="menu" aria-expanded={attachmentOpen}><PaperclipIcon /></button>
              {attachmentOpen && <div className="attachment-menu" role="menu">
                <button type="button" role="menuitem" disabled={imageAttachmentLimitReached} onClick={() => { setAttachmentOpen(false); advanceUserDraftRevision(); imageInputRef.current?.click(); }}><ImageIcon className="attachment-menu-icon" /><strong>图片</strong><small>{resolveImageCapabilityOnSend ? "最多 10 张，单张 8 MB / 总计 40 MB；发送时准备 Runtime 并检查支持" : imageInputPending ? "最多 10 张，单张 8 MB / 总计 40 MB；发送前等待模型能力同步" : acceptsImages ? "最多 10 张，单张 8 MB / 总计 40 MB；直接解析，可粘贴或拖入" : "最多 10 张，单张 8 MB / 总计 40 MB；发送时检查模型支持"}</small></button>
                <button type="button" role="menuitem" disabled={pickingFiles} onClick={() => void pickFiles()}><FileSearchIcon className="attachment-menu-icon" /><strong>{pickingFiles ? "选择中…" : "本地文件"}</strong><small>引用 Windows 绝对路径</small></button>
              </div>}
              <input ref={imageInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void addImages([...event.target.files || []]); event.target.value = ""; }} />
            </div>
            {activelyStreaming
              ? <button type="button" className="stop-button" disabled={disabled || stopping} onClick={() => void onAbort()} aria-label={stopping ? "正在停止" : "停止生成"} title={stopping ? "正在停止" : "停止生成"}><span aria-hidden="true" /></button>
              : !streaming && <button type="button" className="send-button" disabled={(!value.trim() && !images.length) || editorDisabled || stopping} onClick={() => submit()} aria-label={isExtensionCommand ? "执行指令" : "发送消息"} title={isExtensionCommand ? "执行指令" : "发送消息"}><SendIcon /></button>}
          </div>
        </div>
        {dragging && <div className="drop-hint">松开以添加附件</div>}
      </div>
    </div>
  );
}
