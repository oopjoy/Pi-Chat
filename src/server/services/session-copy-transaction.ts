import { randomUUID } from "node:crypto";
import { extname, resolve } from "node:path";
import { HttpRequestError } from "../http-transport.js";
import type { PiState } from "../../shared/types.js";
import { PROMPT_PREPARE_TIMEOUT_MS } from "../prompt-scheduler.js";
import { RpcRequestTimeoutError, rpcData, type PiRpcClient } from "../rpc-client.js";

export interface SessionCopyRpcHost {
  lateRpcOutcomeHandler(sessionId: string, token: string): (response: Record<string, unknown>) => void;
  markRpcOutcomePending(sessionId: string, error: unknown, token: string): void;
  installOutcomeFence(sessionId: string, token: string): void;
  addCopyOutcomePending(sessionId: string): void;
}

export async function executeSessionCopyRpc(input: {
  host: SessionCopyRpcHost;
  rpc: PiRpcClient;
  sourceSessionId: string;
  mode: "clone" | "fork";
  entryId?: string;
}): Promise<{
  state: PiState;
  cancelled: boolean;
  mutationOutcomeUnknown: boolean;
  copyMayHaveCommitted: boolean;
  outcomeToken: string;
}> {
  const outcomeToken = randomUUID();
  let mutationOutcomeUnknown = false;
  let copyMayHaveCommitted = false;
  let cancelled = false;
  try {
    try {
      const result = rpcData<{ cancelled?: boolean }>(
        await input.rpc.send(
          input.mode === "clone" ? { type: "clone" } : { type: "fork", entryId: input.entryId },
          PROMPT_PREPARE_TIMEOUT_MS,
          { onLateResponse: input.host.lateRpcOutcomeHandler(input.sourceSessionId, outcomeToken) },
        ),
      );
      cancelled = result.cancelled === true;
      copyMayHaveCommitted = !cancelled;
    } catch (error) {
      if (!(error instanceof RpcRequestTimeoutError) || !error.outcomeUnknown) throw error;
      mutationOutcomeUnknown = true;
      input.host.addCopyOutcomePending(input.sourceSessionId);
      input.host.markRpcOutcomePending(input.sourceSessionId, error, outcomeToken);
    }
    let state: PiState;
    try {
      state = rpcData<PiState>(await input.rpc.send({ type: "get_state" }, 30_000, { independentRead: true }));
    } catch (error) {
      if (mutationOutcomeUnknown || copyMayHaveCommitted) {
        if (!mutationOutcomeUnknown) input.host.installOutcomeFence(input.sourceSessionId, outcomeToken);
        throw new HttpRequestError(409, "复制结果尚未确认；请刷新对话列表核对，不要重复操作", "RESULT_PENDING", true, true);
      }
      throw error;
    }
    return { state, cancelled, mutationOutcomeUnknown, copyMayHaveCommitted, outcomeToken };
  } catch (error) {
    throw error;
  }
}

export interface CopiedSessionState {
  sessionFile?: string;
  sessionId?: string;
}

export function validateCopiedSessionIdentity(input: {
  sourcePath: string;
  sourceSessionId: string;
  sessionIdForPath: (path: string) => string;
  state: CopiedSessionState;
  knownSessionIds: ReadonlySet<string>;
  liveRuntimeIds: ReadonlySet<string>;
  activeSessionId: string;
  cancelled: boolean;
  mutationOutcomeUnknown: boolean;
  copyMayHaveCommitted: boolean;
  installOutcomeFence: () => void;
  mode: "clone" | "fork";
}): { sessionId: string; sessionPath: string; piSessionId: string } {
  const sourcePath = resolve(input.sourcePath);
  const sessionPath = typeof input.state.sessionFile === "string"
    ? resolve(input.state.sessionFile)
    : "";
  const sessionId = sessionPath ? input.sessionIdForPath(sessionPath) : "";
  const switched = Boolean(
    sessionPath
    && extname(sessionPath).toLowerCase() === ".jsonl"
    && sessionPath.toLowerCase() !== sourcePath.toLowerCase()
    && sessionId !== input.sourceSessionId,
  );
  if (input.cancelled) {
    if (switched) throw new Error("Pi 取消复制后仍切换了会话身份");
    throw new HttpRequestError(
      409,
      input.mode === "clone" ? "扩展取消了复制新对话" : "扩展取消了分叉新对话",
    );
  }
  if (!switched) {
    if (input.mutationOutcomeUnknown || input.copyMayHaveCommitted) {
      if (!input.mutationOutcomeUnknown) input.installOutcomeFence();
      throw new HttpRequestError(409, "复制结果尚未确认；请刷新对话列表核对，不要重复操作", "RESULT_PENDING", true, true);
    }
    throw new Error("Pi 未返回有效的新会话文件");
  }
  if (
    input.knownSessionIds.has(sessionId)
    || input.liveRuntimeIds.has(sessionId)
    || sessionId === input.activeSessionId
    || typeof input.state.sessionId !== "string"
    || !input.state.sessionId
  ) throw new HttpRequestError(409, "Pi 返回的新会话身份与现有会话冲突");
  return { sessionId, sessionPath, piSessionId: input.state.sessionId };
}
