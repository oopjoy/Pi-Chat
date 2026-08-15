import type { PiContentBlock, PiMessage } from "../../shared/types";

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
  if (!text) return null;
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
    <div className="coordination-message-content">{text}</div>
  </article>;
}
