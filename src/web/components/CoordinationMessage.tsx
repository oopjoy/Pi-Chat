import { useState } from "react";
import type { PiContentBlock, PiMessage } from "../../shared/types";

/** Fold only explicit source lines; visual wrapping is device-dependent. */
export const COORDINATION_MESSAGE_FOLD_LINE_LIMIT = 10;

export function shouldFoldCoordinationText(text: string): boolean {
  return text.split(/\r?\n/).length > COORDINATION_MESSAGE_FOLD_LINE_LIMIT;
}

const coordinationTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const coordinationFullTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function coordinationText(message: PiMessage): string {
  const content: PiContentBlock[] = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content || [];
  return content
    .filter((block): block is PiContentBlock & { text: string } =>
      block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function CoordinationMessage({ message }: { message: PiMessage }) {
  const text = coordinationText(message);
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const foldable = shouldFoldCoordinationText(text);
  const source = message.localCoordination?.source?.trim();
  const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? new Date(message.timestamp)
    : null;
  const validTimestamp = timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : null;

  return <article
    className="coordination-message"
    aria-label={source ? `来自 ${source} 的协调消息` : "协调消息"}
  >
    <header>
      <span className="coordination-message-title">
        <span className="coordination-message-icon" aria-hidden="true" />
        <strong>协调消息</strong>
        {source && <span>· {source}</span>}
      </span>
      {validTimestamp && <time
        dateTime={validTimestamp.toISOString()}
        title={`协调消息时间：${coordinationFullTimeFormatter.format(validTimestamp)}`}
      >{coordinationTimeFormatter.format(validTimestamp)}</time>}
    </header>
    <div className="coordination-message-content">
      <div className={foldable && !expanded ? "is-collapsed" : undefined}>{text}</div>
      {foldable && <button
        type="button"
        className="coordination-message-fold-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >{expanded ? "收起" : "展开全部"}</button>}
    </div>
  </article>;
}
