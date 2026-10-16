export type LifecycleActionHolders = {
  running: boolean;
  queued: boolean;
  pendingConfirmation: boolean;
  busy: boolean;
  lifecycleBlocked: boolean;
  loading?: boolean;
  refreshing?: boolean;
};

/** Hover copy while Restart/Quit is disabled. Null means the control is idle. */
export function lifecycleActionHoldReason(
  action: "重启" | "关闭",
  holders: LifecycleActionHolders,
): string | null {
  if (holders.running) return `有对话正在生成，结束后才能${action}`;
  if (holders.pendingConfirmation) return `有对话正在等待确认，处理后再${action}`;
  if (holders.queued) return `有待发送的消息，结束后才能${action}`;
  if (holders.busy || holders.lifecycleBlocked) return `Pi Chat 正在执行其他操作，请稍候再${action}`;
  if (holders.loading || holders.refreshing) return `正在加载，请稍候再${action}`;
  return null;
}
