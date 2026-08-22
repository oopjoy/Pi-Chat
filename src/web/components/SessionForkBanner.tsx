import type { SessionForkOrigin } from "../../shared/types";

export function SessionForkBanner({ origin, onOpenSource }: {
  origin: SessionForkOrigin;
  onOpenSource: () => void;
}) {
  return <section className="session-fork-banner" aria-label="分叉来源">
    <div>
      <strong>分叉对话</strong>
      <span>从“{origin.sourceName}”中的一条 User 消息之前创建</span>
    </div>
    {origin.sourceAvailable
      ? <button type="button" onClick={onOpenSource}>返回原对话</button>
      : <span className="session-fork-source-missing">原对话已不存在</span>}
  </section>;
}
