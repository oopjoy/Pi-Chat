import type { PiRpcClient } from "../rpc-client.js";
import { HttpRequestError } from "../http-transport.js";

export interface ExtensionResponseTarget {
  rpc: PiRpcClient;
  release(): void;
}

export interface ExtensionResponsePorts {
  target(sessionId: string): ExtensionResponseTarget | null;
  hasUncertain(sessionId: string): boolean;
  pendingRequest(sessionId: string): { id: string } | undefined;
  claim(claimKey: string): boolean;
  releaseClaim(claimKey: string): void;
  rpcOutcomeUnknown(error: unknown): boolean;
  markOutcomePending(sessionId: string, error: unknown): void;
  markUncertain(sessionId: string): void;
  rethrowResultPending(error: unknown, operation: string): never;
  clearPending(sessionId: string, requestId: string): void;
}

export async function respondToExtension(
  ports: ExtensionResponsePorts,
  input: {
    sessionId: string;
    requestId: string;
    cancelled?: boolean;
    confirmed?: boolean;
    value?: string;
  },
): Promise<void> {
  const target = ports.target(input.sessionId);
  if (!target)
    throw new HttpRequestError(409, "Extension 对应的会话已经关闭");
  const claimKey = `${input.sessionId}\u0000${input.requestId}`;
  let claimed = false;
  try {
    if (ports.hasUncertain(input.sessionId))
      throw new HttpRequestError(
        409,
        "上一次 Extension 回应结果尚未确认；请等待对话结束或刷新页面核对",
        "RESULT_PENDING",
        true,
      );
    const pending = ports.pendingRequest(input.sessionId);
    if (!pending || pending.id !== input.requestId || !ports.claim(claimKey))
      throw new HttpRequestError(409, "该确认已在另一窗口处理，或已失效");
    claimed = true;
    const command: Record<string, unknown> = {
      type: "extension_ui_response",
      id: input.requestId,
    };
    if (input.cancelled === true) command.cancelled = true;
    else if (typeof input.confirmed === "boolean") command.confirmed = input.confirmed;
    else if (typeof input.value === "string") command.value = input.value;
    else command.cancelled = true;
    try {
      await target.rpc.sendRaw(command);
    } catch (error) {
      if (ports.rpcOutcomeUnknown(error)) {
        ports.markUncertain(input.sessionId);
        ports.markOutcomePending(input.sessionId, error);
        ports.rethrowResultPending(error, "确认 Extension 回应");
      }
      throw error;
    }
    ports.clearPending(input.sessionId, input.requestId);
  } finally {
    target.release();
    if (claimed) ports.releaseClaim(claimKey);
  }
}
