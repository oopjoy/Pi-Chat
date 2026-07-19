import type { QueuedPrompt } from "../../shared/types";

export function PromptQueue({ queue, paused, busy, onCancel, onResume }: {
  queue: QueuedPrompt[];
  paused: boolean;
  busy: boolean;
  onCancel: (id: string) => void;
  onResume: () => void;
}) {
  if (!queue.length) return null;
  return <section className={`prompt-queue ${paused ? "is-paused" : ""}`} aria-label="待处理消息队列">
    <header><span>{paused ? "队列已暂停" : "等待执行"}</span><strong>{queue.length}</strong>{paused && <button type="button" disabled={busy} onClick={onResume}>继续队列</button>}</header>
    <div>{queue.map((item, index) => <article key={item.id}><span>{index + 1}</span><p>{item.message || "请查看附加图片"}{item.imageCount > 0 && <small>{item.imageCount} 张图片</small>}</p><button type="button" disabled={busy} onClick={() => onCancel(item.id)} aria-label="撤销队列消息">撤销</button></article>)}</div>
  </section>;
}
