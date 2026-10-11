import { randomUUID } from "node:crypto";
import type { ModelInfo, ThinkingLevel } from "../../shared/types.js";
import { PartialTurnSettingsError, type AppliedTurnSettings, type PendingTurnSettings } from "../runtime-pool.js";
import { HttpRequestError } from "../http-transport.js";
import { asModels, asState } from "../pi-data.js";
import { THINKING_LEVELS } from "../routes/request-validation.js";
import type { RpcLateResponseHandler, RpcSendOptions } from "../rpc-client.js";

export type TurnSettingsCommand =
  | { type: "get_available_models" }
  | { type: "get_state" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: ThinkingLevel };

/** This transaction cannot send prompts, restart a process, or switch Sessions. */
export interface TurnSettingsRpc {
  readonly send: (command: Readonly<TurnSettingsCommand>, timeoutMs?: number, options?: Pick<RpcSendOptions, "onLateResponse">) => Promise<Record<string, unknown>>;
}

export type TurnSettingsSnapshot = Readonly<{
  model?: Readonly<NonNullable<PendingTurnSettings["model"]>>;
  thinkingLevel?: ThinkingLevel;
}>;

export interface TurnSettingsPorts {
  lateRpcOutcomeHandler(sessionId: string, token: string): RpcLateResponseHandler;
  /** The App retains the policy deciding which failed writes have unknown outcomes. */
  markRpcOutcomePending(sessionId: string, error: unknown, token: string): undefined;
  rememberModelContextWindows(models: readonly ModelInfo[]): undefined;
}

export function createTurnSettingsAction(ports: TurnSettingsPorts) {
  async function applyTurnSettings(
    rpc: TurnSettingsRpc,
    settings: TurnSettingsSnapshot,
    sessionId?: string,
  ): Promise<AppliedTurnSettings> {
    const applied: AppliedTurnSettings = {};
    const requestedModel = settings.model;
    if (requestedModel) {
      const available = asModels(await rpc.send({ type: "get_available_models" }));
      const model = available.find(candidate =>
        candidate.provider === requestedModel.provider && candidate.id === requestedModel.modelId
        && (!requestedModel.api || candidate.api === requestedModel.api),
      );
      if (!model)
        throw new HttpRequestError(
          400,
          `所选模型不可用：${requestedModel.provider}/${requestedModel.modelId} 不在当前会话 Pi Runtime 的模型列表中（该 Runtime 提供 ${available.length} 个模型）。请在模型菜单中改选该 Runtime 提供的模型；若你刚更新过模型配置，请重启该会话的 Pi Runtime 后重试。`,
          "MODEL_UNAVAILABLE",
        );
      // The documented set_model command cannot distinguish API routes with
      // the same provider/id. Never acknowledge a route Pi cannot select.
      if (new Set(available
        .filter(candidate => candidate.provider === requestedModel.provider && candidate.id === requestedModel.modelId)
        .map(candidate => candidate.api || "")).size > 1)
        throw new HttpRequestError(
          409,
          `所选模型路由当前 Pi Runtime 无法区分：${requestedModel.provider}/${requestedModel.modelId}${requestedModel.api ? `（${requestedModel.api}）` : ""}。请在 Pi Runtime 支持 API 路由选择前改用唯一模型 ID。`,
          "MODEL_ROUTE_AMBIGUOUS",
        );
      const outcomeToken = randomUUID();
      try {
        await rpc.send({ type: "set_model", provider: model.provider, modelId: model.id }, undefined, {
          onLateResponse: ports.lateRpcOutcomeHandler(sessionId || "", outcomeToken),
        });
      } catch (error) {
        ports.markRpcOutcomePending(sessionId || "", error, outcomeToken);
        throw error;
      }
      ports.rememberModelContextWindows([model]);
      applied.model = model;
      if (model.reasoning === false) applied.thinkingLevel = "off";
    }
    if (settings.thinkingLevel && applied.model?.reasoning !== false) {
      const outcomeToken = randomUUID();
      try {
        await rpc.send({ type: "set_thinking_level", level: settings.thinkingLevel }, undefined, {
          onLateResponse: ports.lateRpcOutcomeHandler(sessionId || "", outcomeToken),
        });
      } catch (error) {
        ports.markRpcOutcomePending(sessionId || "", error, outcomeToken);
        if (applied.model) throw new PartialTurnSettingsError(applied, error);
        throw error;
      }
      applied.thinkingLevel = settings.thinkingLevel;
    }
    const appliedModel = applied.model;
    if (requestedModel && appliedModel && appliedModel.reasoning !== false) {
      try {
        const state = asState(await rpc.send({ type: "get_state" }));
        const thinkingLevel = THINKING_LEVELS.find(level => level === state.thinkingLevel);
        if (state.model?.provider === appliedModel.provider && state.model.id === appliedModel.id && thinkingLevel)
          applied.thinkingLevel = thinkingLevel;
      } catch (error) {
        // Writes are already acknowledged. Read failure must not reclassify
        // their outcomes or invent an unconfirmed clamped value.
        console.warn(`[Pi Chat] 切换模型后无法确认 Thinking 强度${sessionId ? `（Session ${sessionId}）` : ""}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return applied;
  }
  return applyTurnSettings;
}
