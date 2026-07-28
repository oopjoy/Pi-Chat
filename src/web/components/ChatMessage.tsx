import { memo, useEffect, useRef, useState } from "react";
import type { PiContentBlock, PiMessage } from "../../shared/types";
import { visibleAssistantBlocks } from "../lib/assistant-text";
import { CheckIcon, CopyIcon } from "./Icons";
import { MarkdownBody } from "./MarkdownBody";

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

export const ChatMessage = memo(function ChatMessage({ message, streaming = false }: { message: PiMessage; streaming?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
  }, []);

  if (message.role !== "user" && message.role !== "assistant") return null;
  const content = message.role === "assistant" ? visibleAssistantBlocks(message) : blocks(message);
  const hasVisibleContent = content.some((block) =>
    (block.type === "text" && Boolean(block.text))
    || (block.type === "image" && Boolean(block.data && block.mimeType)),
  );
  if (!streaming && !hasVisibleContent) return null;
  const copyText = message.role === "assistant" ? assistantCopyText(content) : "";
  const modelLabel = message.role === "assistant" ? assistantModelLabel(message) : "";
  const thinkingLabel = message.role === "assistant" ? assistantThinkingLabel(message) : "";
  const copyAnswer = async () => {
    if (!copyText) return;
    await navigator.clipboard.writeText(copyText);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    setCopied(true);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_600);
  };

  return (
    <article className={`message message-${message.role}`}>
      {message.role === "assistant" && streaming && <header>
        <span className="streaming-dot" aria-label="正在生成" />
      </header>}
      <div className="message-content">
        {content.map((block, index) => {
          if (block.type === "text" && block.text) {
            // User input is deliberately literal. Prompts often contain partial
            // Markdown, shell syntax, paths, or unmatched delimiters; rendering
            // those as Markdown produces misleading red/error-like formatting.
            if (message.role === "user") return <div className="user-plain-text" key={index}>{block.text}</div>;
            return <MarkdownBody key={index} streaming={streaming}>{block.text}</MarkdownBody>;
          }
          if (block.type === "image" && block.data && block.mimeType) {
            return <img className="message-image" key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="用户附加图片" />;
          }
          return null;
        })}
        {streaming && !content.some((block) => block.type === "text" && block.text) && (
          <div className="working">Pi 正在工作…</div>
        )}
      </div>
      {message.role === "assistant" && (modelLabel || thinkingLabel || copyText) && <footer className="message-footer">
        <span className="message-metadata">
          {modelLabel && <span className="message-model" title={modelLabel}>{modelLabel}</span>}
          {thinkingLabel && <span className="message-thinking" title={`思考强度：${thinkingLabel}`}>{thinkingLabel}</span>}
        </span>
        {copyText && <button type="button" onClick={() => void copyAnswer()} aria-label={copied ? "回答已复制" : "复制整个回答"} title={copied ? "已复制" : "复制整个回答"}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>}
      </footer>}
    </article>
  );
});
