import type { PendingSteer } from "../../shared/types";

export function PendingSteers({ items }: { items: PendingSteer[] }) {
  if (!items.length) return null;
  return <section className="pending-steers" aria-label="等待送达的 Steer 消息">
    <header>
      <span>等待送达的 Steer</span><strong>{items.length}</strong>
    </header>
    <div>{items.map((item) => <article key={item.id}>
      <b>Steer</b>
      <p>{item.message || "请查看附加图片"}{item.imageCount > 0 && <small>{item.imageCount} 张图片</small>}</p>
      <span>等待 Pi 接收</span>
    </article>)}</div>
  </section>;
}
