import type { PendingSteer } from "../../shared/types";

export function PendingSteers({ items, dequeueing = false, onDequeue }: {
  items: PendingSteer[];
  dequeueing?: boolean;
  onDequeue: () => void;
}) {
  if (!items.length) return null;
  return <section className="pending-steers" aria-label="等待送达的 Steer 消息">
    <header>
      <span>等待送达的 Steer</span><strong>{items.length}</strong>
      <button
        type="button"
        disabled={dequeueing}
        onClick={onDequeue}
        title="像 Pi Alt+Up 一样撤回全部尚未消费的 Steer"
      >{dequeueing ? "撤回中…" : "撤回全部"}</button>
    </header>
    <div>{items.map((item) => <article key={item.id}>
      <b>Steer</b>
      <p>{item.message || "请查看附加图片"}{item.imageCount > 0 && <small>{item.imageCount} 张图片</small>}</p>
      <span>等待 Pi 接收</span>
    </article>)}</div>
  </section>;
}
