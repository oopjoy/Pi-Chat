import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PiContentBlock, PiMessage } from "../../shared/types";
import { visibleAssistantBlocksWithSourceIndex } from "../lib/assistant-text";
import { streamingAppendHint } from "../lib/streaming-append";
import { CheckIcon, CopyIcon, ForkIcon } from "./Icons";
import { MarkdownBody } from "./MarkdownBody";

/** Fold only explicit source lines; visual wrapping stays device-dependent. */
export const USER_MESSAGE_FOLD_LINE_LIMIT = 20;

export function shouldFoldUserText(text: string): boolean {
  return text.split(/\r?\n/).length > USER_MESSAGE_FOLD_LINE_LIMIT;
}

function blocks(message: PiMessage): PiContentBlock[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content || [];
}

export function assistantCopyText(content: PiContentBlock[]): string {
  return content
    .filter((block): block is PiContentBlock & { text: string } => block.type === "text" && typeof block.text === "string" && Boolean(block.text))
    .map((block) => block.text)
    .join("\n\n");
}

export function assistantModelLabel(message: PiMessage): string {
  if (!message.model) return "";
  if (!message.provider || message.model.startsWith(`${message.provider}/`)) return message.model;
  return `${message.provider} / ${message.model}`;
}

export function assistantThinkingLabel(message: PiMessage): string {
  const level = message.thinkingLevel;
  if (level === "minimal") return "min";
  if (["off", "low", "medium", "high", "xhigh", "max"].includes(level || "")) return level === "medium" ? "med" : level!;
  return "";
}

export interface AssistantGeneratedAt {
  label: string;
  dateTime: string;
  title: string;
}

const replyTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const replyMonthDayFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
});
const replyFullFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function assistantGeneratedAt(timestamp: number | undefined, now = Date.now()): AssistantGeneratedAt | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const generated = new Date(timestamp);
  if (Number.isNaN(generated.getTime())) return null;
  const current = new Date(now);
  const sameYear = generated.getFullYear() === current.getFullYear();
  const sameDay = sameYear
    && generated.getMonth() === current.getMonth()
    && generated.getDate() === current.getDate();
  const time = replyTimeFormatter.format(generated);
  const compact = sameDay
    ? time
    : sameYear
      ? `${replyMonthDayFormatter.format(generated)} ${time}`
      : `${generated.getFullYear()}/${replyMonthDayFormatter.format(generated)} ${time}`;
  return {
    label: `生成于 ${compact}`,
    dateTime: generated.toISOString(),
    title: `回复生成时间：${replyFullFormatter.format(generated)}`,
  };
}

type AssistantMetadataFallback = Pick<PiMessage, "provider" | "model" | "thinkingLevel">;

export function AssistantMessageHeader({ message, fallback }: { message: PiMessage; fallback?: AssistantMetadataFallback }) {
  const resolvedMessage = {
    ...message,
    provider: message.provider || fallback?.provider,
    model: message.model || fallback?.model,
    thinkingLevel: message.thinkingLevel || fallback?.thinkingLevel,
  };
  const modelLabel = assistantModelLabel(resolvedMessage);
  const thinkingLabel = assistantThinkingLabel(resolvedMessage);
  if (!modelLabel && !thinkingLabel) return null;
  return <header className="message-assistant-header">
    <span className="message-metadata">
      {modelLabel && <span className="message-model" title={modelLabel}>{modelLabel}</span>}
      {thinkingLabel && <span className="message-thinking" title={`思考强度：${thinkingLabel}`}>{thinkingLabel}</span>}
    </span>
  </header>;
}

export const ChatMessage = memo(function ChatMessage({ message, streaming = false, showAssistantMetadata = true, showGeneratedAt = true, assistantMetadataFallback, onForkUserMessage, forkUserMessageDisabled = false }: { message: PiMessage; streaming?: boolean; showAssistantMetadata?: boolean; showGeneratedAt?: boolean; assistantMetadataFallback?: AssistantMetadataFallback; onForkUserMessage?: (message: PiMessage) => void; forkUserMessageDisabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [expandedUserText, setExpandedUserText] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string; width: number; height: number } | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
  }, []);
  useEffect(() => {
    if (!previewImage) return;
    previewCloseRef.current?.focus();
    const closePreview = () => setPreviewImage(null);
    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key === "Escape") return closePreview();
      if (event.key === "Tab") {
        event.preventDefault();
        previewCloseRef.current?.focus();
      }
    };
    document.addEventListener("keydown", keepFocusInDialog);
    return () => document.removeEventListener("keydown", keepFocusInDialog);
  }, [previewImage]);
  useEffect(() => {
    if (previewImage || !previewTriggerRef.current) return;
    previewTriggerRef.current.focus();
    previewTriggerRef.current = null;
  }, [previewImage]);
  if (message.role !== "user" && message.role !== "assistant") return null;
  const assistantContent = message.role === "assistant"
    ? visibleAssistantBlocksWithSourceIndex(message)
    : [];
  const content = message.role === "assistant"
    ? assistantContent.map(({ block }) => block)
    : blocks(message);
  const hasVisibleContent = content.some((block) =>
    (block.type === "text" && Boolean(block.text))
    || (block.type === "image" && Boolean(block.data && block.mimeType)),
  );
  if (!hasVisibleContent && (!streaming || !showAssistantMetadata)) return null;
  const copyText = message.role === "assistant" ? assistantCopyText(content) : "";
  const userTextBlocks = message.role === "user" ? content.filter((block): block is PiContentBlock & { text: string } => block.type === "text" && typeof block.text === "string" && Boolean(block.text)) : [];
  const userImageBlocks = message.role === "user" ? content.filter((block): block is PiContentBlock & { data: string; mimeType: string } => block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") : [];
  const userTextNeedsFolding = userTextBlocks.some((block) => shouldFoldUserText(block.text));
  const forkableUserMessage = message.role === "user" &&
    Boolean(message.piChatPersistedMessageId) &&
    userTextBlocks.length > 0 &&
    userImageBlocks.length === 0 &&
    Boolean(onForkUserMessage);
  const generatedAt = message.role === "assistant" && !streaming && showGeneratedAt
    ? assistantGeneratedAt(message.timestamp)
    : null;
  const copyAnswer = async () => {
    if (!copyText) return;
    await navigator.clipboard.writeText(copyText);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    setCopied(true);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_600);
  };

  return (
    <article className={`message message-${message.role}${userTextNeedsFolding ? " is-foldable" : ""}`}>
      {message.role === "assistant" && showAssistantMetadata && <AssistantMessageHeader message={message} fallback={assistantMetadataFallback} />}
      {message.role === "user" && userImageBlocks.length > 0 && <div className="message-user-attachments" aria-label="用户附加图片">
        {userImageBlocks.map((block, index) => {
          const src = `data:${block.mimeType};base64,${block.data}`;
          const alt = "用户附加图片";
          return <button type="button" className="message-image-thumbnail" key={index} onClick={(event) => {
            previewTriggerRef.current = event.currentTarget;
            const viewport = window.visualViewport;
            setPreviewImage({
              src,
              alt,
              width: viewport?.width || window.innerWidth,
              height: viewport?.height || window.innerHeight,
            });
          }} aria-label="查看用户附加图片的大图"><img className="message-image" src={src} alt={alt} /></button>;
        })}
      </div>}
      {(message.role !== "user" || userTextBlocks.length > 0) && <div className="message-content">
        {message.role === "user"
          ? userTextBlocks.map((block, index) => <div className={`user-plain-text${userTextNeedsFolding && !expandedUserText ? " is-collapsed" : ""}`} key={index}>{block.text}</div>)
          : content.map((block, index) => {
            if (block.type === "text" && block.text) return <MarkdownBody
              key={index}
              streaming={streaming}
              appendHint={streaming ? streamingAppendHint(message, assistantContent[index]?.sourceIndex ?? index) : undefined}
            >{block.text}</MarkdownBody>;
            if (block.type === "image" && block.data && block.mimeType) return <img className="message-image" key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="用户附加图片" />;
            return null;
          })}
        {message.role === "user" && userTextNeedsFolding && <button
          type="button"
          className="user-message-fold-toggle"
          aria-expanded={expandedUserText}
          onClick={() => setExpandedUserText((current) => !current)}
        >{expandedUserText ? "收起" : "展开全部"}</button>}
      </div>}
      {previewImage && <div
        className="image-preview-backdrop"
        role="presentation"
        onClick={(event) => { if (event.target === event.currentTarget) setPreviewImage(null); }}
      >
        <section
          className="image-preview-dialog"
          style={{ maxWidth: `${Math.max(0, previewImage.width - 48)}px`, maxHeight: `${Math.max(0, previewImage.height - 48)}px` } as CSSProperties}
          role="dialog"
          aria-modal="true"
          aria-label="用户附加图片预览"
        >
          <button ref={previewCloseRef} type="button" className="image-preview-close" onClick={() => setPreviewImage(null)} aria-label="关闭图片预览" title="关闭图片预览">关闭</button>
          <img
            className="image-preview-full"
            style={{ maxWidth: `${Math.max(0, previewImage.width - 74)}px`, maxHeight: `${Math.max(0, previewImage.height - 102)}px` } as CSSProperties}
            src={previewImage.src}
            alt={previewImage.alt}
          />
        </section>
      </div>}
      {forkableUserMessage && <footer className="message-user-actions">
        <button
          type="button"
          disabled={forkUserMessageDisabled}
          onClick={() => onForkUserMessage?.(message)}
          aria-label="在新对话中分叉"
          title={forkUserMessageDisabled ? "等待当前生成、压缩、确认和队列结束后再分叉" : "在新对话中分叉"}
        ><ForkIcon /></button>
      </footer>}
      {message.role === "assistant" && (generatedAt || copyText) && <footer className="message-footer">
        {generatedAt && <time className="message-generated-at" dateTime={generatedAt.dateTime} title={generatedAt.title}>{generatedAt.label}</time>}
        {copyText && <button type="button" onClick={() => void copyAnswer()} aria-label={copied ? "回答已复制" : "复制整个回答"} title={copied ? "已复制" : "复制整个回答"}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>}
      </footer>}
    </article>
  );
});
