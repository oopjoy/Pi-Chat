import { memo } from "react";
import type { PiContentBlock, PiMessage } from "../../shared/types";
import { MarkdownBody } from "./MarkdownBody";

function blocks(message: PiMessage): PiContentBlock[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content || [];
}

export const ChatMessage = memo(function ChatMessage({ message, streaming = false }: { message: PiMessage; streaming?: boolean }) {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const content = blocks(message);
  const hasVisibleContent = content.some((block) =>
    (block.type === "text" && Boolean(block.text))
    || (block.type === "image" && Boolean(block.data && block.mimeType)),
  );
  if (!streaming && !hasVisibleContent) return null;
  return (
    <article className={`message message-${message.role}`}>
      {message.role === "assistant" && <header>
        {streaming && <span className="streaming-dot" aria-label="正在生成" />}
        {message.model && <span className="message-model">{message.model}</span>}
      </header>}
      <div className="message-content">
        {content.map((block, index) => {
          if (block.type === "text" && block.text) {
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
    </article>
  );
});
