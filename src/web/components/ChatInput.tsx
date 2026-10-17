import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGES_TOTAL_BYTES,
} from "../../shared/rpc-contracts";
import type { PromptDelivery, PromptImage, SlashCommand } from "../../shared/types";
import { useComposerController, type ComposerRestoredDraft } from "../hooks/use-composer-controller";
import { composerDraftKeyId, type ComposerDraftKey } from "../state/composer";
import { MAX_COMPOSER_FILES, composePromptWithAttachedFiles, draftFiles } from "../state/composer";
export { composePromptWithAttachedFiles };
import { CloseIcon, FileIcon, FileSearchIcon, FileTextIcon, FolderIcon, ImageIcon, PaperclipIcon, SendIcon } from "./Icons";
import { ImagePreviewDialog } from "./ImagePreviewDialog";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const COMPOSITION_END_ENTER_GRACE_MS = 100;
export const MAX_DROPPED_FILE_BYTES = 64 * 1024 * 1024;

export function droppedFilePreflightError(
  existingCount: number,
  files: Array<{ name: string; size: number }>,
): string | null {
  if (!files.length) return null;
  if (existingCount + files.length > MAX_COMPOSER_FILES)
    return `一次最多附加 ${MAX_COMPOSER_FILES} 个本地文件`;
  const oversized = files.find((file) => file.size > MAX_DROPPED_FILE_BYTES);
  if (oversized) return `文件 ${oversized.name} 超过 64 MB，无法从拖入附加`;
  return null;
}

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

function readDroppedFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      if (comma < 0) return reject(new Error(`无法读取文件：${file.name}`));
      resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function isDroppedDirectory(item: DataTransferItem | undefined): boolean {
  try {
    return Boolean(item?.webkitGetAsEntry?.()?.isDirectory);
  } catch {
    return false;
  }
}

function droppedEntryNames(files: File[], items: DataTransferItem[]): string[] {
  const names: string[] = [];
  for (const [index, item] of items.entries()) {
    try {
      const entry = item.webkitGetAsEntry?.();
      if (entry?.name) {
        names.push(entry.name);
        continue;
      }
    } catch { /* Chromium may throw for some items */ }
    if (files[index]?.name) names.push(files[index].name);
  }
  if (!names.length) names.push(...files.map((file) => file.name).filter(Boolean));
  return [...new Set(names)];
}

function dataTransferStringReads(data: DataTransfer): Array<Promise<string>> {
  return [...data.items].filter((item) => item.kind === "string").map((item) => new Promise<string>((resolve) => {
    try { item.getAsString((value) => resolve(value || "")); }
    catch { resolve(""); }
  }));
}

export function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/][^<>:"|?*\u0000-\u001f]*$/.test(value)
    && value.length > 3;
}

function parsedWindowsPathLine(line: string): string {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return "";
  const quoted = raw.startsWith('"') || raw.endsWith('"');
  if (quoted && !(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return "";
  let clean = quoted ? raw.slice(1, -1) : raw;
  const fromFileUri = /^file:\/\//i.test(clean);
  if (fromFileUri) {
    try {
      const url = new URL(clean);
      const authorityStart = "file://".length;
      const authorityEnd = clean.indexOf("/", authorityStart);
      const authority = clean.slice(
        authorityStart,
        authorityEnd < 0 ? clean.length : authorityEnd,
      );
      const driveHost = /^[a-z]$/i.test(url.hostname);
      if (
        url.protocol !== "file:"
        || (url.hostname && url.hostname.toLowerCase() !== "localhost" && !driveHost)
        || authority.includes("@")
        || (authority.includes(":") && !/^[A-Za-z]:$/.test(authority))
        || /[?#]/.test(clean.slice("file:".length))
        || url.username
        || url.password
        || url.port
        || url.search
        || url.hash
      ) return "";
      let pathname = decodeURIComponent(url.pathname || "");
      if (driveHost && pathname.startsWith("/")) pathname = `${url.hostname}:${pathname}`;
      clean = pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\");
    } catch {
      return "";
    }
  }
  if (!isWindowsAbsolutePath(clean)) return "";
  // An unquoted final component containing spaces is indistinguishable from
  // prose appended after a path. Explorer supplies URI/quoted forms for such
  // paths; requiring quotes here prevents ordinary text from being consumed.
  if (!quoted && !fromFileUri && /\s/.test(clean.split(/[\\/]/).at(-1) || "")) return "";
  return clean;
}

function quoteWindowsPath(path: string): string {
  const clean = path.trim().replace(/^"|"$/g, "");
  if (!isWindowsAbsolutePath(clean)) return "";
  // Keep ordinary Explorer paths readable; quote only paths whose whitespace
  // would make the boundary ambiguous in a natural-language prompt.
  return /\s/.test(clean) ? `"${clean.replace(/"/g, '\\"')}"` : clean;
}

export function fileReferences(paths: string[]): string {
  return [...new Set(paths.map((path) => quoteWindowsPath(path)).filter(Boolean))].join(" ");
}

export function windowsFileName(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || path;
}

export type LocalAttachmentFamily = "folder" | "pdf" | "log" | "text" | "office" | "sheet" | "slides" | "archive" | "code" | "data" | "generic";

export function localAttachmentKind(path: string, fsKind?: "file" | "directory"): { family: LocalAttachmentFamily; label: string } {
  if (fsKind === "directory") return { family: "folder", label: "文件夹" };
  const name = windowsFileName(path);
  const dotted = name.includes(".") ? name.split(".").pop() || "" : "";
  const ext = dotted.toLowerCase();
  const label = ext ? ext.toUpperCase() : "文件";
  if (ext === "pdf") return { family: "pdf", label };
  if (ext === "log" || ext === "out" || ext === "err") return { family: "log", label };
  if (ext === "txt" || ext === "md" || ext === "rst" || ext === "csv" || ext === "tex" || ext === "ltx" || ext === "sty" || ext === "cls") return { family: "text", label };
  if (ext === "json" || ext === "yml" || ext === "yaml" || ext === "xml" || ext === "toml") return { family: "data", label };
  if (ext === "doc" || ext === "docx" || ext === "rtf" || ext === "odt") return { family: "office", label };
  if (ext === "xls" || ext === "xlsx" || ext === "ods") return { family: "sheet", label };
  if (ext === "ppt" || ext === "pptx" || ext === "odp") return { family: "slides", label };
  if (ext === "zip" || ext === "7z" || ext === "rar" || ext === "tar" || ext === "gz") return { family: "archive", label };
  if (["js", "ts", "tsx", "jsx", "py", "rs", "go", "c", "h", "cpp", "java", "cs"].includes(ext)) return { family: "code", label };
  return { family: "generic", label };
}

export function windowsPathsFromText(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map(parsedWindowsPathLine).filter(Boolean))];
}

function parseExplorerPathLine(line: string): string {
  const strict = parsedWindowsPathLine(line);
  if (strict) return strict;
  const value = line.trim().replace(/^"(.*)"$/s, "$1").replace(/\//g, "\\");
  if (!isWindowsAbsolutePath(value)) return "";
  if (/\s(?:and|or)\s/i.test(value) || /\.\s/.test(value)) return "";
  return value;
}

/** Explorer file lists are one path per line; spaces in the last component are allowed. */
export function explorerWindowsPaths(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (!lines.length) return [];
  const paths = lines.map(parseExplorerPathLine);
  return paths.every(Boolean) ? [...new Set(paths)] : [];
}

/** Explorer drag exposes paths in several text flavors; never let an empty uri-list hide text/plain. */
export function windowsPathsFromDataTransfer(data: { types?: Iterable<string>; getData(type: string): string }): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  const types = new Set(["text/uri-list", "text/plain", "text", ...Array.from(data.types || [])]);
  for (const type of types) {
    if (type === "Files") continue;
    try {
      const value = data.getData(type);
      if (value && !seen.has(value)) {
        seen.add(value);
        texts.push(value);
      }
    } catch {
      // Chromium throws for some internal types during drop.
    }
  }
  return [...new Set(texts.flatMap((text) => [...windowsPathsFromText(text), ...explorerWindowsPaths(text)]))];
}

/**
 * Prefer browser-exposed clipboard text before invoking the slower Windows
 * clipboard bridge. URI lists commonly contain comment lines, so validate
 * each representation independently and fall back from URI to plain text.
 */
export function clipboardWindowsPaths(uriList: string, plainText: string): string[] {
  for (const text of [uriList, plainText]) {
    const meaningfulLines = text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const paths = windowsPathsFromText(text);
    if (paths.length && paths.length === meaningfulLines.length) return paths;
    const explorerPaths = explorerWindowsPaths(text);
    if (explorerPaths.length) return explorerPaths;
  }
  return [];
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

export function ChatInput({ streaming, activelyStreaming = streaming, stopping, disabled, disabledPlaceholder, placeholder, acceptsImages, imageInputPending = false, restoredDraft, onDraftRevisionChange, draftKey, forgottenComposerKeys = [], submissionScope, submissionTargetSessionId, allowFollowupSubmissions = true, submissionPaused = false, onSubmissionPendingChange, commands, controls, notices, onSend, onAbort, onPickLocalFiles, onReadClipboardFiles = async () => [], onOpenLocalFile, onStageDroppedFile, onDiscardStagedFile, onReadExplorerSelection, onAttachmentKinds, onError }: {
  /** True when a submission will enter the local queue. */
  streaming: boolean;
  /** True only while Pi is actively generating and can be stopped. */
  activelyStreaming?: boolean;
  stopping: boolean;
  disabled: boolean;
  disabledPlaceholder?: string;
  placeholder?: string;
  /** Advisory model metadata used only for the attachment hint; it never gates forwarding. */
  acceptsImages: boolean;
  /** The selected model metadata is provisional; unknown support never blocks forwarding. */
  imageInputPending?: boolean;
  /** A cancelled queued prompt replaces the current Composer draft. */
  restoredDraft?: ComposerRestoredDraft | null;
  onDraftRevisionChange?: (key: ComposerDraftKey, revision: number, hasContent: boolean) => void;
  /** Typed partition for an existing prompt target or one New draft generation. */
  draftKey?: ComposerDraftKey;
  /** Session-keyed Composer partitions to forget after structural deletion. */
  forgottenComposerKeys?: string[];
  /** Stable pane identity used only for App-owned pending projections. */
  submissionScope: string;
  /** Immutable normal-session prompt target, never inferred again after navigation. */
  submissionTargetSessionId?: string;
  /** A materialized Session can accept another editor snapshot while one is pending. */
  allowFollowupSubmissions?: boolean;
  /** Keeps accepted editor snapshots local until their target may be submitted. */
  submissionPaused?: boolean;
  onSubmissionPendingChange?: (scope: string, count: number) => void;
  commands: SlashCommand[];
  controls?: ReactNode;
  /** System status sits immediately above the actual Composer, never over its input. */
  notices?: ReactNode;
  onSend: (message: string, images: PromptImage[], delivery?: PromptDelivery, targetSessionId?: string) => Promise<void>;
  onAbort: () => Promise<void>;
  onPickLocalFiles: () => Promise<string[]>;
  onReadClipboardFiles?: (files: Array<{ name: string; size: number }>) => Promise<string[]>;
  onOpenLocalFile?: (path: string) => Promise<void>;
  onStageDroppedFile?: (file: { name: string; data: string; size: number }) => Promise<string>;
  onDiscardStagedFile?: (path: string) => Promise<void>;
  onReadExplorerSelection?: (names: string[]) => Promise<string[]>;
  onAttachmentKinds?: (paths: string[]) => Promise<Array<{ path: string; kind: "file" | "directory" }>>;
  onError: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const previewTriggerRef = useRef<HTMLElement | null>(null);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [pickingFiles, setPickingFiles] = useState(false);
  const [attachmentKinds, setAttachmentKinds] = useState<Record<string, "file" | "directory">>({});
  const attachmentKindsRef = useRef(attachmentKinds);
  attachmentKindsRef.current = attachmentKinds;
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const suggestionListId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<HTMLDivElement>(null);
  const attachmentButtonRef = useRef<HTMLButtonElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const editorDisabledRef = useRef(disabled);
  const attachingCountRef = useRef(0);
  const [attachingCount, setAttachingCount] = useState(0);
  const attachmentEpochRef = useRef(0);
  const attachWaitersRef = useRef<Array<() => void>>([]);
  /** Paths this component wrote into the managed temp staging area. */
  const stagedPathsRef = useRef(new Set<string>());
  const onDiscardStagedFileRef = useRef(onDiscardStagedFile);
  onDiscardStagedFileRef.current = onDiscardStagedFile;
  // Legacy unit fixtures may provide only a scope. Production App always
  // supplies the typed identity; the fallback retains the old fixture contract.
  const resolvedDraftKey: ComposerDraftKey = draftKey || (
    submissionScope.startsWith("draft:")
      ? { kind: "new", generation: Number(submissionScope.slice(6)) || 0 }
      : { kind: "session", sessionId: submissionScope.replace(/^session:/, "") }
  );
  const currentDraftKeyIdRef = useRef(composerDraftKeyId(resolvedDraftKey));
  currentDraftKeyIdRef.current = composerDraftKeyId(resolvedDraftKey);

  const lastAttachmentKeyIdRef = useRef(composerDraftKeyId(resolvedDraftKey));
  useEffect(() => {
    const next = composerDraftKeyId(resolvedDraftKey);
    if (lastAttachmentKeyIdRef.current === next) return;
    lastAttachmentKeyIdRef.current = next;
    attachmentEpochRef.current += 1;
  }, [composerDraftKeyId(resolvedDraftKey)]);

  const beginAttachment = () => {
    attachingCountRef.current += 1;
    setAttachingCount(attachingCountRef.current);
    return attachmentEpochRef.current;
  };
  const endAttachment = () => {
    attachingCountRef.current = Math.max(0, attachingCountRef.current - 1);
    setAttachingCount(attachingCountRef.current);
    if (attachingCountRef.current === 0) {
      const waiters = attachWaitersRef.current;
      attachWaitersRef.current = [];
      for (const waiter of waiters) waiter();
    }
  };
  const waitForAttachments = () => {
    if (attachingCountRef.current === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { attachWaitersRef.current.push(resolve); });
  };
  const discardStagedPaths = async (paths: string[]) => {
    const discard = onDiscardStagedFileRef.current;
    if (!discard || !paths.length) return;
    for (const path of paths) stagedPathsRef.current.delete(path);
    await Promise.all(paths.map((path) => discard(path).catch(() => undefined)));
  };
  /** A removed card must not leave its staged bytes behind in the temp area. */
  const discardIfStaged = (path: string) => {
    if (!stagedPathsRef.current.has(path)) return;
    void discardStagedPaths([path]);
  };
  const composer = useComposerController({
    draftKey: resolvedDraftKey,
    forgottenKeys: forgottenComposerKeys,
    targetSessionId: submissionTargetSessionId,
    disabled,
    paused: submissionPaused,
    allowFollowupSubmissions,
    restoredDraft,
    onDraftRevisionChange,
    onSubmissionPendingChange,
    onError,
    onSend,
  });
  const value = composer.draft.message;
  const images = composer.draft.images;
  const files = draftFiles(composer.draft);
  const attachedFilesKey = files.join("\0");
  useEffect(() => {
    const currentFiles = attachedFilesKey ? attachedFilesKey.split("\0") : [];
    setAttachmentKinds((current) => {
      const next = { ...current };
      let changed = false;
      for (const path of Object.keys(next)) {
        if (!currentFiles.includes(path)) {
          delete next[path];
          changed = true;
        }
      }
      return changed ? next : current;
    });
    if (!onAttachmentKinds) return;
    const missing = currentFiles.filter((path) => !attachmentKindsRef.current[path]);
    if (!missing.length) return;
    const draftKeyId = currentDraftKeyIdRef.current;
    void onAttachmentKinds(missing).then((kinds) => {
      if (currentDraftKeyIdRef.current !== draftKeyId) return;
      setAttachmentKinds((current) => {
        const next = { ...current };
        for (const item of kinds) next[item.path] = item.kind;
        return next;
      });
    }).catch(() => undefined);
  }, [attachedFilesKey, onAttachmentKinds]);
  const suggestions = useMemo(() => commandMatches(value, commands), [commands, value]);
  const invokedCommand = value.startsWith("/") ? commands.find((command) => command.name === value.slice(1).split(/\s/, 1)[0]) : undefined;
  const isExtensionCommand = invokedCommand?.source === "extension";

  useEffect(() => {
    if (!restoredDraft) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [restoredDraft, resolvedDraftKey]);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const viewportHeight = textarea.ownerDocument.defaultView?.visualViewport?.height
      || textarea.ownerDocument.defaultView?.innerHeight
      || 0;
    // Preserve room for the visible transcript and the software keyboard while
    // allowing a comfortably sized technical draft before internal scrolling.
    const maxHeight = Math.min(240, Math.max(115, Math.floor(viewportHeight * 0.35)));
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = "auto";
  }, []);

  useEffect(() => {
    resizeTextarea();
    setSuggestionIndex((current) => Math.min(current, Math.max(0, suggestions.length - 1)));
  }, [resizeTextarea, suggestions.length, value]);

  useEffect(() => {
    const view = textareaRef.current?.ownerDocument.defaultView;
    const viewport = view?.visualViewport;
    const resize = () => resizeTextarea();
    view?.addEventListener("resize", resize);
    viewport?.addEventListener("resize", resize);
    return () => {
      view?.removeEventListener("resize", resize);
      viewport?.removeEventListener("resize", resize);
    };
  }, [resizeTextarea]);

  const currentPendingSubmissions = composer.pendingCount;
  const submissionLocked = !allowFollowupSubmissions && currentPendingSubmissions > 0;
  const editorDisabled = disabled || submissionLocked;
  editorDisabledRef.current = editorDisabled;
  const imageAttachmentLimitReached =
    images.length >= MAX_PROMPT_IMAGES ||
    promptImagesByteLength(images) >= MAX_PROMPT_IMAGES_TOTAL_BYTES;
  const imageAttachmentHint = imageInputPending
    ? "最多 10 张，单张 8 MB / 总计 40 MB；能力未知，仍会直接发送给上游模型"
    : acceptsImages
      ? "最多 10 张，单张 8 MB / 总计 40 MB；图片将随消息交给上游模型处理"
      : "最多 10 张，单张 8 MB / 总计 40 MB；是否支持由上游模型返回结果";

  const closeAttachmentMenu = (restoreFocus = false) => {
    setAttachmentOpen(false);
    if (restoreFocus)
      window.setTimeout(() => attachmentButtonRef.current?.focus(), 0);
  };

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
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeAttachmentMenu(true);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    const focusTimer = window.setTimeout(() => {
      attachmentMenuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    }, 0);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.clearTimeout(focusTimer);
    };
  }, [attachmentOpen, editorDisabled]);

  const addImages = async (files: File[]) => {
    if (editorDisabled) return;
    const candidates = files.filter((file) => file.type.startsWith("image/"));
    if (!candidates.length) return;
    const preflightError = promptImageAdditionError(composer.currentDraft().images, candidates);
    if (preflightError) return onError(preflightError);
    const epoch = beginAttachment();
    const draftKeyId = currentDraftKeyIdRef.current;
    try {
      const added = await Promise.all(candidates.map(imageFromFile));
      if (attachmentEpochRef.current !== epoch || currentDraftKeyIdRef.current !== draftKeyId || editorDisabledRef.current) return;
      // FileReader completions may overlap across paste/drop/picker events. Recheck
      // against the latest partition so count and byte caps remain atomic.
      const current = composer.currentDraft();
      const commitError = promptImageAdditionError(
        current.images,
        added.map((image) => ({ name: image.fileName, size: promptImageByteLength(image) })),
      );
      if (commitError) return onError(commitError);
      composer.replace(current.message, [...current.images, ...added], draftFiles(current));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      endAttachment();
    }
  };

  const completeCommand = (command: SlashCommand) => {
    composer.edit(`/${command.name} `);
    setSuggestionIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submit = (delivery: PromptDelivery = "queue") => {
    const epoch = attachmentEpochRef.current;
    const draftKeyId = currentDraftKeyIdRef.current;
    const run = () => {
      if (attachmentEpochRef.current !== epoch || currentDraftKeyIdRef.current !== draftKeyId) return;
      const current = composer.currentDraft();
      const message = current.message.trim();
      if (!message && !current.images.length && !draftFiles(current).length) return;
      if (delivery === "steer" && message.startsWith("/")) {
        onError("Slash 指令不能作为 Steer 消息发送");
        return;
      }
      // ModelInfo.input is advisory metadata, not a client-side admission gate.
      // Forward the complete prompt and let the upstream model/API decide whether
      // it can interpret the attached images and return an ordinary response.
      if (!composer.submit(delivery)) return;
      attachmentEpochRef.current += 1;
    };
    if (attachingCountRef.current === 0) run();
    else void waitForAttachments().then(run);
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent;
    const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
    const composing = composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
    // IME candidates own Enter/arrow keys. The short post-composition window
    // also prevents a confirming Enter from becoming an accidental send.
    if (event.key === "Enter" && !event.shiftKey && (composing || recentlyComposed)) {
      if (recentlyComposed) event.preventDefault();
      return;
    }
    if (composing) return;
    if (suggestions.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setSuggestionIndex((index) => (index + 1) % suggestions.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length); return; }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && `/${suggestions[suggestionIndex].name}` !== value)) { event.preventDefault(); completeCommand(suggestions[suggestionIndex]); return; }
      if (event.key === "Escape") { event.preventDefault(); const current = composer.currentDraft(); composer.edit(current.message === "/" ? "" : current.message); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const attachFiles = (paths: string[], expectedDraftKeyId?: string) => {
    if (editorDisabledRef.current) return false;
    const incoming = [...new Set(paths.map((path) => path.trim()).filter((path) => isWindowsAbsolutePath(path)))];
    if (!incoming.length) return false;
    const current = composer.currentDraft();
    if (expectedDraftKeyId && currentDraftKeyIdRef.current !== expectedDraftKeyId) return false;
    const next = [...new Set([...draftFiles(current), ...incoming])];
    if (next.length > MAX_COMPOSER_FILES) {
      onError(`一次最多附加 ${MAX_COMPOSER_FILES} 个本地文件`);
      return false;
    }
    composer.replace(current.message, current.images, next);
    return true;
  };

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardFiles = [...event.clipboardData.items].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    const imageFiles = clipboardFiles.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length) {
      event.preventDefault();
      void addImages(imageFiles);
      return;
    }
    const uriList = event.clipboardData.getData("text/uri-list");
    const plainText = event.clipboardData.getData("text/plain");
    const textPaths = clipboardWindowsPaths(uriList, plainText);
    const directPaths = clipboardFiles
      .map((file) => (file as File & { path?: string }).path || "")
      .filter(isWindowsAbsolutePath);
    const paths = [...new Set([...directPaths, ...textPaths])];
    if (paths.length) {
      event.preventDefault();
      attachFiles(paths);
      return;
    }
    if (clipboardFiles.length || event.clipboardData.types.includes("Files")) {
      event.preventDefault();
      const draftKeyId = currentDraftKeyIdRef.current;
      const epoch = beginAttachment();
      const files = clipboardFiles.map((file) => ({ name: file.name, size: file.size }));
      void onReadClipboardFiles(files).then((nativePaths) => {
        if (attachmentEpochRef.current !== epoch || currentDraftKeyIdRef.current !== draftKeyId || editorDisabledRef.current) return;
        if (nativePaths.length) attachFiles(nativePaths, draftKeyId);
        else onError("无法取得文件的本地路径，请使用发送按钮旁的附件按钮选择本地文件");
      }).catch(() => {
        if (attachmentEpochRef.current === epoch && currentDraftKeyIdRef.current === draftKeyId && !editorDisabledRef.current)
          onError("无法取得文件的本地路径，请使用发送按钮旁的附件按钮选择本地文件");
      }).finally(() => endAttachment());
    }
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (editorDisabled) return;
    const files = [...event.dataTransfer.files];
    const items = [...event.dataTransfer.items];
    const imageFiles = files.filter((file) => (file.type || "").startsWith("image/"));
    if (imageFiles.length) void addImages(imageFiles);
    const directPaths = files.map((file) => (file as File & { path?: string }).path || "").filter(isWindowsAbsolutePath);
    const transferredPaths = windowsPathsFromDataTransfer(event.dataTransfer);
    const paths = [...new Set([...directPaths, ...transferredPaths])];
    if (paths.length) {
      attachFiles(paths);
      return;
    }
    const ordinaryFiles = files.filter((file, index) => !(file.type || "").startsWith("image/") && !isDroppedDirectory(items[index]));
    const droppedDirectory = items.some((item) => isDroppedDirectory(item));
    if (imageFiles.length && !ordinaryFiles.length && !droppedDirectory) return;
    const names = droppedEntryNames(files, items);
    const stringReads = dataTransferStringReads(event.dataTransfer);
    const draftKeyId = currentDraftKeyIdRef.current;
    const epoch = beginAttachment();
    void (async () => {
      const staged: string[] = [];
      try {
        const asyncTexts = await Promise.all(stringReads);
        const asyncPaths = [...new Set(asyncTexts.flatMap((text) => [...windowsPathsFromText(text), ...explorerWindowsPaths(text)]))];
        if (asyncPaths.length) {
          if (attachmentEpochRef.current === epoch && currentDraftKeyIdRef.current === draftKeyId && !editorDisabledRef.current)
            attachFiles(asyncPaths, draftKeyId);
          return;
        }
        // A file carries its own bytes, so the content is exactly what was
        // dragged. Matching a name against other Explorer windows could attach
        // an unrelated same-named file, so staging bytes always wins for files.
        if (ordinaryFiles.length && onStageDroppedFile) {
          const preflight = droppedFilePreflightError(draftFiles(composer.currentDraft()).length, ordinaryFiles);
          if (preflight) {
            onError(preflight);
            return;
          }
          for (const file of ordinaryFiles) {
            const data = await readDroppedFileAsBase64(file);
            const path = await onStageDroppedFile({ name: file.name, data, size: file.size });
            if (path) {
              staged.push(path);
              stagedPathsRef.current.add(path);
            }
            if (attachmentEpochRef.current !== epoch) {
              await discardStagedPaths(staged);
              return;
            }
          }
          if (attachmentEpochRef.current !== epoch || currentDraftKeyIdRef.current !== draftKeyId || editorDisabledRef.current) {
            await discardStagedPaths(staged);
            return;
          }
          if (staged.length) {
            if (!attachFiles(staged, draftKeyId)) await discardStagedPaths(staged);
            return;
          }
        }
        // A directory has no bytes to stage, so its original path is the only
        // usable identity. Accept it only when every dropped name matched
        // exactly one entry and each entry is really a directory.
        if (droppedDirectory && names.length && onReadExplorerSelection) {
          let selected: string[] = [];
          try { selected = await onReadExplorerSelection(names); }
          catch { selected = []; }
          if (selected.length && onAttachmentKinds) {
            try {
              const kinds = await onAttachmentKinds(selected);
              const allDirectories = kinds.length === selected.length
                && kinds.every((item) => item.kind === "directory");
              if (!allDirectories) selected = [];
            } catch {
              selected = [];
            }
          }
          if (selected.length) {
            if (attachmentEpochRef.current === epoch && currentDraftKeyIdRef.current === draftKeyId && !editorDisabledRef.current)
              attachFiles(selected, draftKeyId);
            return;
          }
        }
        if (attachmentEpochRef.current !== epoch || currentDraftKeyIdRef.current !== draftKeyId || editorDisabledRef.current) return;
        if (droppedDirectory) onError("无法取得文件夹的本地路径，请使用发送按钮旁的附件按钮选择");
        else if (ordinaryFiles.length || names.length) onError("浏览器未提供文件的绝对路径，请使用发送按钮旁的附件按钮选择本地文件");
        // Nothing usable was dropped (for example a text selection). Say so
        // instead of silently swallowing the gesture after preventDefault.
        else onError("拖入的内容不是本地文件；请拖入文件、文件夹，或使用发送按钮旁的附件按钮");
      } catch (error) {
        await discardStagedPaths(staged);
        if (attachmentEpochRef.current === epoch && currentDraftKeyIdRef.current === draftKeyId && !editorDisabledRef.current)
          onError(error instanceof Error ? error.message : String(error));
      } finally {
        endAttachment();
      }
    })();
  };

  const pickFiles = async () => {
    if (editorDisabled) return;
    setAttachmentOpen(false);
    setPickingFiles(true);
    const targetDraftKeyId = currentDraftKeyIdRef.current;
    const epoch = beginAttachment();
    composer.edit(composer.currentDraft().message);
    try {
      const paths = await onPickLocalFiles();
      if (attachmentEpochRef.current !== epoch || currentDraftKeyIdRef.current !== targetDraftKeyId || editorDisabledRef.current) return;
      attachFiles(paths, targetDraftKeyId);
      textareaRef.current?.focus();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPickingFiles(false);
      endAttachment();
    }
  };

  return (
    <div className="composer-wrap">
      {notices && <div className="system-notice-stack" aria-live="polite">{notices}</div>}
      {composer.blocked && <div className="composer-submission-status is-failed" role="status">发送失败，草稿已恢复；{composer.blockedError || "修改后可重试"}</div>}
      {attachingCount > 0 && <div className="composer-submission-status" role="status">正在附加文件…</div>}
      <div className={`composer ${dragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; if (!editorDisabled) setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop}>
        {!editorDisabled && suggestions.length > 0 && <div id={suggestionListId} className="command-suggestions" role="listbox" aria-label="Pi 指令联想">{suggestions.map((command, index) => <button id={`${suggestionListId}-option-${index}`} type="button" role="option" aria-selected={index === suggestionIndex} className={index === suggestionIndex ? "is-active" : ""} key={`${command.source}-${command.name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => completeCommand(command)}><strong>/{command.name}</strong><span>{command.description || "Pi 指令"}</span><small>{command.source}</small></button>)}</div>}
        {(images.length > 0 || files.length > 0) && <div className="composer-attachments" aria-label="附件">
          {images.map((image, index) => <div className="composer-attachment is-image image-preview" key={`${image.fileName}-${index}`}>
            <button type="button" className="composer-attachment-face" disabled={editorDisabled} onClick={(event) => { previewTriggerRef.current = event.currentTarget; setPreviewImage({ src: `data:${image.mimeType};base64,${image.data}`, alt: image.fileName || `图片 ${index + 1}` }); }}>
              <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.fileName || `图片 ${index + 1}`} />
            </button>
            <small>{image.fileName || "粘贴的图片"}</small>
            <button type="button" className="composer-attachment-remove" disabled={editorDisabled} onClick={() => { const current = composer.currentDraft(); composer.replace(current.message, current.images.filter((_, itemIndex) => itemIndex !== index), draftFiles(current)); }} aria-label={`移除 ${image.fileName || "图片"}`}><CloseIcon /></button>
          </div>)}
          {files.map((path) => {
            const kind = localAttachmentKind(path, attachmentKinds[path]);
            const Icon = kind.family === "folder" ? FolderIcon : kind.family === "log" || kind.family === "text" || kind.family === "code" ? FileTextIcon : FileIcon;
            return <div className={`composer-attachment is-file is-${kind.family}`} key={path}>
              <button type="button" className="composer-attachment-face" disabled={editorDisabled} title={path} onClick={() => { void onOpenLocalFile?.(path).catch((error) => onError(error instanceof Error ? error.message : String(error))); }}>
                <Icon className="composer-attachment-icon" />
                <span className="composer-attachment-kind">{kind.label}</span>
              </button>
              <small>{windowsFileName(path)}</small>
              <button type="button" className="composer-attachment-remove" disabled={editorDisabled} aria-label={`移除 ${windowsFileName(path)}`} onClick={() => { discardIfStaged(path); const current = composer.currentDraft(); composer.replace(current.message, current.images, draftFiles(current).filter((item) => item !== path)); }}><CloseIcon /></button>
            </div>;
          })}
        </div>}
        <textarea ref={textareaRef} value={value} onChange={(event) => composer.edit(event.target.value)} onPaste={paste} onKeyDown={keyDown} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; lastCompositionEndAtRef.current = Date.now(); }} disabled={editorDisabled} rows={1} placeholder={editorDisabled ? disabledPlaceholder || "输入消息，或粘贴、拖入附件" : placeholder || (streaming ? "继续输入，发送后加入队列；输入 / 查看指令" : "输入消息，或粘贴、拖入附件")} aria-label="消息输入" aria-autocomplete="list" aria-expanded={suggestions.length > 0} aria-controls={suggestions.length > 0 ? suggestionListId : undefined} aria-activedescendant={suggestions.length > 0 ? `${suggestionListId}-option-${suggestionIndex}` : undefined} />
        <div className="composer-toolbar">
          <div className="composer-toolbar-controls">{controls}</div>
          <div className="composer-actions">
            {streaming && <button type="button" className="queue-submit-button" disabled={(!value.trim() && !images.length && !files.length && attachingCount === 0) || editorDisabled || stopping} onClick={() => submit("queue")}>{isExtensionCommand ? "执行" : "排队"}</button>}
            {activelyStreaming && !value.trimStart().startsWith("/") && <button type="button" className="steer-submit-button" disabled={(!value.trim() && !images.length && !files.length && attachingCount === 0) || editorDisabled || stopping} onClick={() => submit("steer")} title="在当前 assistant turn 的工具调用结束后、下一次模型调用前优先送达">Steer</button>}
            <div className="attachment-control" ref={attachmentRef}>
              <button ref={attachmentButtonRef} type="button" className={`attachment-button ${attachmentOpen ? "is-open" : ""}`} disabled={editorDisabled || pickingFiles} onClick={() => attachmentOpen ? closeAttachmentMenu(true) : setAttachmentOpen(true)} title="添加附件" aria-label="添加附件" aria-haspopup="menu" aria-expanded={attachmentOpen}><PaperclipIcon /></button>
              {attachmentOpen && <div ref={attachmentMenuRef} className="attachment-menu" role="menu">
                <button type="button" role="menuitem" disabled={imageAttachmentLimitReached} onClick={() => { setAttachmentOpen(false); composer.edit(composer.currentDraft().message); imageInputRef.current?.click(); }}><ImageIcon className="attachment-menu-icon" /><strong>图片</strong><small>{imageAttachmentHint}</small></button>
                <button type="button" role="menuitem" disabled={pickingFiles} onClick={() => void pickFiles()}><FileSearchIcon className="attachment-menu-icon" /><strong>{pickingFiles ? "选择中…" : "本地文件"}</strong><small>按需读取，不上传全文</small></button>
              </div>}
              <input ref={imageInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void addImages([...event.target.files || []]); event.target.value = ""; }} />
            </div>
            {activelyStreaming
              ? <button type="button" className="stop-button" disabled={disabled || stopping} onClick={() => void onAbort()} aria-label={stopping ? "正在停止" : "停止生成"} title={stopping ? "正在停止" : "停止生成"}><span aria-hidden="true" /></button>
              : !streaming && <button type="button" className="send-button" disabled={(!value.trim() && !images.length && !files.length && attachingCount === 0) || editorDisabled || stopping} onClick={() => submit()} aria-label={isExtensionCommand ? "执行指令" : "发送消息"} title={isExtensionCommand ? "执行指令" : "发送消息"}><SendIcon /></button>}
          </div>
        </div>
        {dragging && <div className="drop-hint">松开以添加附件</div>}
      </div>
      {previewImage && <ImagePreviewDialog src={previewImage.src} alt={previewImage.alt} label="输入框图片预览" returnFocusTo={() => previewTriggerRef.current} onClose={() => setPreviewImage(null)} />}
    </div>
  );
}
