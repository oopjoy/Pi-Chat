const RECOVERABLE_REFRESH_ERROR = /请求超时|RPC 请求超时|RPC 查询仍在处理中/;

export function recoverableRefreshError(message: string): boolean {
  return RECOVERABLE_REFRESH_ERROR.test(message);
}

/**
 * Automatic read-only refreshes are best-effort once a readable projection is
 * already painted. A timeout there must not look like conversation loss or a
 * failed mutation; the next SSE/sidebar refresh will retry it. Initial startup
 * without any readable projection still surfaces the failure.
 */
export function surfaceAutomaticRefreshError(
  message: string,
  hasReadableProjection: boolean,
): boolean {
  return !hasReadableProjection || !recoverableRefreshError(message);
}
