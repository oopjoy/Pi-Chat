export function SessionControlBanner({ observing, disabled = false, onTakeOver }: {
  observing: boolean;
  disabled?: boolean;
  onTakeOver: () => void;
}) {
  if (!observing) return null;
  return <div className="session-control-banner" role="status">
    <span>此对话正在另一窗口中控制；当前为只读观察。</span>
    <button type="button" disabled={disabled} onClick={onTakeOver}>接管控制</button>
  </div>;
}
