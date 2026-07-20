export function SessionControlBanner({ observing, onTakeOver }: {
  observing: boolean;
  onTakeOver: () => void;
}) {
  if (!observing) return null;
  return <div className="session-control-banner" role="status">
    <span>此对话正在另一窗口中控制；当前为只读观察。</span>
    <button type="button" onClick={onTakeOver}>接管控制</button>
  </div>;
}
