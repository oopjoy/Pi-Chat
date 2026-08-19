export interface ComposerWaitStatusInput {
  isStreaming: boolean;
  pendingSubmissions: number;
  viewSwitching: boolean;
  runtimePreparing: boolean;
  compacting: boolean;
  subagentTargetUnavailable: boolean;
}

/**
 * Describe the one conversation-body status that owns a retained Composer
 * snapshot. The Composer itself stays free of a duplicate informational banner.
 */
export function composerWaitStatus({
  isStreaming,
  pendingSubmissions,
  viewSwitching,
  runtimePreparing,
  compacting,
  subagentTargetUnavailable,
}: ComposerWaitStatusInput): string {
  const hasPendingSubmission = pendingSubmissions > 0;
  if (hasPendingSubmission && subagentTargetUnavailable)
    return "子代理父对话地址尚未验证；消息已保存，验证恢复后自动发送…";
  if (compacting)
    return hasPendingSubmission
      ? "正在压缩上下文；消息已保存，压缩完成后自动发送…"
      : "";
  if (isStreaming) return "";
  // Report the immediate admission barrier before the later Runtime work that
  // is already reserved but cannot begin until navigation ownership settles.
  if (hasPendingSubmission && viewSwitching)
    return "消息已保存，等待会话切换完成后自动发送…";
  if (hasPendingSubmission && runtimePreparing)
    return "正在准备 Pi Runtime；消息已保存，准备完成后自动发送…";
  if (hasPendingSubmission) return "消息已提交，正在等待 Pi 处理…";
  if (runtimePreparing) return "正在准备 Pi Runtime…";
  return "";
}
