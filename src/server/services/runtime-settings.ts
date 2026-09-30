import { randomUUID } from "node:crypto";
import type { ModelInfo, PiState, ThinkingLevel } from "../../shared/types.js";
import { HttpRequestError } from "../http-transport.js";
import type { PiRpcClient } from "../rpc-client.js";
import { rpcData } from "../rpc-client.js";
import type { SecondaryRuntime } from "../runtime-pool.js";

export interface RuntimeSettingsPorts {
  activeSessionId(): string;
  primaryRpc(): PiRpcClient;
  primaryRunning(): boolean;
  secondaryRuntime(sessionId: string): SecondaryRuntime | null;
  ensurePrimaryRuntime(): Promise<void>;
  recoverSecondary(runtime: SecondaryRuntime): Promise<void>;
  withSecondaryOperation<T>(runtime: SecondaryRuntime, operation: () => Promise<T>): Promise<T>;
  acquirePrimaryOperation(): () => void;
  mutationOutcomePending(sessionId: string): boolean;
  availableModels(rpc: PiRpcClient): Promise<ModelInfo[]>;
  lateRpcOutcomeHandler(sessionId: string, token: string): (response: Record<string, unknown>) => void;
  markRpcOutcomePending(sessionId: string, error: unknown, token: string): void;
  rethrowResultPending(error: unknown, operation: string, fence?: boolean): never;
  rememberRuntimeModel(runtime: SecondaryRuntime, model: ModelInfo): void;
  rememberPrimaryModel(model: ModelInfo): void;
  stagePrimaryModel(provider: string, modelId: string): void;
  rememberRuntimeThinking(runtime: SecondaryRuntime, level: ThinkingLevel): void;
  rememberPrimaryThinking(level: ThinkingLevel): void;
  stagePrimaryThinking(level: ThinkingLevel): void;
  updateRuntimeState(runtime: SecondaryRuntime, state: PiState): void;
  updatePrimaryState(state: PiState): void;
}

function modelUnavailable(provider: string, modelId: string, secondary: boolean): never {
  throw new HttpRequestError(
    404,
    `所选模型不可用：${provider}/${modelId} 不在${secondary ? "该会话" : "当前"} Pi Runtime 的模型列表中。请改选 Runtime 提供的模型；若刚更新过模型配置，请重启该会话的 Pi Runtime 后重试。`,
    "MODEL_UNAVAILABLE",
  );
}

export function createRuntimeSettingsService(ports: RuntimeSettingsPorts) {
  const setModel = async (sessionId: string, provider: string, modelId: string) => {
    const runtime = ports.secondaryRuntime(sessionId);
    if (!runtime && sessionId !== ports.activeSessionId())
      throw new HttpRequestError(409, "该会话尚未启用");
    if (runtime) {
      return ports.withSecondaryOperation(runtime, async () => {
        if (runtime.failed || runtime.rpc.isRunning?.() === false) await ports.recoverSecondary(runtime);
        if (ports.mutationOutcomePending(sessionId))
          throw new HttpRequestError(409, "上一次操作结果尚未确认；请刷新页面核对，不要重复修改设置", "RESULT_PENDING", true);
        if (runtime.running) {
          const model = (await ports.availableModels(runtime.rpc)).find((item) => item.provider === provider && item.id === modelId);
          if (!model) modelUnavailable(provider, modelId, true);
          runtime.pendingTurnSettings.model = { provider, modelId };
          ports.rememberRuntimeModel(runtime, model);
          return { model, pending: true };
        }
        const token = randomUUID();
        try {
          const response = await runtime.rpc.send({ type: "set_model", provider, modelId }, undefined, {
            onLateResponse: ports.lateRpcOutcomeHandler(sessionId, token),
          });
          const model = rpcData<ModelInfo>(response);
          ports.rememberRuntimeModel(runtime, model);
          return { model, pending: false };
        } catch (error) {
          ports.markRpcOutcomePending(sessionId, error, token);
          ports.rethrowResultPending(error, "更新模型");
        }
      });
    }
    const release = ports.acquirePrimaryOperation();
    try {
      await ports.ensurePrimaryRuntime();
      if (ports.mutationOutcomePending(sessionId))
        throw new HttpRequestError(409, "上一次操作结果尚未确认；请刷新页面核对，不要重复修改设置", "RESULT_PENDING", true);
      const rpc = ports.primaryRpc();
      if (ports.primaryRunning()) {
        const model = (await ports.availableModels(rpc)).find((item) => item.provider === provider && item.id === modelId);
        if (!model) modelUnavailable(provider, modelId, false);
        ports.stagePrimaryModel(provider, modelId);
        ports.rememberPrimaryModel(model);
        return { model, pending: true };
      }
      const token = randomUUID();
      try {
        const response = await rpc.send({ type: "set_model", provider, modelId }, undefined, {
          onLateResponse: ports.lateRpcOutcomeHandler(sessionId, token),
        });
        const model = rpcData<ModelInfo>(response);
        ports.rememberPrimaryModel(model);
        return { model, pending: false };
      } catch (error) {
        ports.markRpcOutcomePending(sessionId, error, token);
        ports.rethrowResultPending(error, "更新模型");
      }
    } finally {
      release();
    }
  };

  const setThinking = async (sessionId: string, level: ThinkingLevel) => {
    const runtime = ports.secondaryRuntime(sessionId);
    if (!runtime && sessionId !== ports.activeSessionId())
      throw new HttpRequestError(409, "该会话尚未启用");
    if (runtime) {
      return ports.withSecondaryOperation(runtime, async () => {
        if (runtime.failed || runtime.rpc.isRunning?.() === false) await ports.recoverSecondary(runtime);
        if (ports.mutationOutcomePending(sessionId))
          throw new HttpRequestError(409, "上一次操作结果尚未确认；请刷新页面核对，不要重复修改设置", "RESULT_PENDING", true);
        if (runtime.running) {
          runtime.pendingTurnSettings.thinkingLevel = level;
          ports.rememberRuntimeThinking(runtime, level);
          return { level, pending: true };
        }
        const token = randomUUID();
        try {
          await runtime.rpc.send({ type: "set_thinking_level", level }, undefined, {
            onLateResponse: ports.lateRpcOutcomeHandler(sessionId, token),
          });
        } catch (error) {
          ports.markRpcOutcomePending(sessionId, error, token);
          ports.rethrowResultPending(error, "更新 Thinking 强度");
        }
        try {
          const state = rpcData<PiState>(await runtime.rpc.send({ type: "get_state" }));
          ports.updateRuntimeState(runtime, state);
          return { level: state.thinkingLevel || level, pending: false };
        } catch (error) {
          if (error instanceof Error && "outcomeUnknown" in error && (error as Error & { outcomeUnknown?: boolean }).outcomeUnknown)
            ports.rethrowResultPending(error, "确认 Thinking 强度", false);
          throw error;
        }
      });
    }
    const release = ports.acquirePrimaryOperation();
    try {
      await ports.ensurePrimaryRuntime();
      if (ports.mutationOutcomePending(sessionId))
        throw new HttpRequestError(409, "上一次操作结果尚未确认；请刷新页面核对，不要重复修改设置", "RESULT_PENDING", true);
      if (ports.primaryRunning()) {
        ports.stagePrimaryThinking(level);
        ports.rememberPrimaryThinking(level);
        return { level, pending: true };
      }
      const token = randomUUID();
      try {
        await ports.primaryRpc().send({ type: "set_thinking_level", level }, undefined, {
          onLateResponse: ports.lateRpcOutcomeHandler(sessionId, token),
        });
      } catch (error) {
        ports.markRpcOutcomePending(sessionId, error, token);
        ports.rethrowResultPending(error, "更新 Thinking 强度");
      }
      try {
        const state = rpcData<PiState>(await ports.primaryRpc().send({ type: "get_state" }));
        ports.updatePrimaryState(state);
        return { level: state.thinkingLevel || level, pending: false };
      } catch (error) {
        if (error instanceof Error && "outcomeUnknown" in error && (error as Error & { outcomeUnknown?: boolean }).outcomeUnknown)
          ports.rethrowResultPending(error, "确认 Thinking 强度", false);
        throw error;
      }
    } finally {
      release();
    }
  };

  return { setModel, setThinking };
}
