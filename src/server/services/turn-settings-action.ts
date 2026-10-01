import type { ThinkingLevel } from "../../shared/types.js";
import type { AppliedTurnSettings, PendingTurnSettings } from "../runtime-pool.js";
import type { PiRpcClient } from "../rpc-client.js";

export function createTurnSettingsAction(host: Record<string, any>) {
  const {
    HttpRequestError,
    PartialTurnSettingsError,
    THINKING_LEVELS,
    asModels,
    asState,
    randomUUID,
  } = host;
  async function applyTurnSettings(
    rpc: PiRpcClient,
    settings: PendingTurnSettings,
    sessionId?: string,
  ): Promise<AppliedTurnSettings> {
    const applied: AppliedTurnSettings = {};
    if (settings.model) {
      const available = asModels(
        await rpc.send({ type: "get_available_models" }),
      );
      const model = available.find(
        (candidate: any) =>
          candidate.provider === settings.model!.provider &&
          candidate.id === settings.model!.modelId &&
          // When the browser captured the Runtime API, require the same full
          // route. Legacy inventories may omit api and remain pair-compatible.
          (!settings.model!.api || candidate.api === settings.model!.api),
      );
      // Name the rejected pair and the catalogue it was checked against: a
      // silent generic message left the user unable to tell which Runtime
      // refused the selection or that the catalogue simply lacks that model.
      if (!model)
        throw new HttpRequestError(
          400,
          `所选模型不可用：${settings.model.provider}/${settings.model.modelId} 不在当前会话 Pi Runtime 的模型列表中（该 Runtime 提供 ${available.length} 个模型）。请在模型菜单中改选该 Runtime 提供的模型；若你刚更新过模型配置，请重启该会话的 Pi Runtime 后重试。`,
          "MODEL_UNAVAILABLE",
        );
      // Pi RPC's documented set_model command accepts only provider/modelId.
      // Two advertised API routes sharing that pair cannot be selected
      // deterministically by this Runtime version, so reject the ambiguous
      // route instead of acknowledging a choice Pi cannot faithfully execute.
      if (
        new Set(
          available
            .filter(
              (candidate: any) =>
                candidate.provider === settings.model!.provider &&
                candidate.id === settings.model!.modelId,
            )
            .map((candidate: any) => candidate.api || ""),
        ).size > 1
      )
        throw new HttpRequestError(
          409,
          `所选模型路由当前 Pi Runtime 无法区分：${settings.model.provider}/${settings.model.modelId}${settings.model.api ? `（${settings.model.api}）` : ""}。请在 Pi Runtime 支持 API 路由选择前改用唯一模型 ID。`,
          "MODEL_ROUTE_AMBIGUOUS",
        );
      const outcomeToken = randomUUID();
      try {
        await rpc.send(
          {
            type: "set_model",
            provider: model.provider,
            modelId: model.id,
          },
          undefined,
          {
            onLateResponse: host.lateRpcOutcomeHandler(
              sessionId || "",
              outcomeToken,
              "generic",
            ),
          },
        );
      } catch (error) {
        host.markRpcOutcomePending(sessionId || "", error, outcomeToken);
        throw error;
      }
      host.rememberModelContextWindows([model]);
      applied.model = model;
      // Pi clamps every non-reasoning model to off as part of set_model. Record
      // that known side effect and do not issue an incompatible follow-up
      // strength that would make the hot display diverge from Runtime state.
      if (model.reasoning === false) applied.thinkingLevel = "off";
    }
    if (settings.thinkingLevel && applied.model?.reasoning !== false) {
      const outcomeToken = randomUUID();
      try {
        await rpc.send(
          {
            type: "set_thinking_level",
            level: settings.thinkingLevel,
          },
          undefined,
          {
            onLateResponse: host.lateRpcOutcomeHandler(
              sessionId || "",
              outcomeToken,
              "generic",
            ),
          },
        );
      } catch (error) {
        host.markRpcOutcomePending(sessionId || "", error, outcomeToken);
        if (applied.model)
          throw new PartialTurnSettingsError(applied, error);
        throw error;
      }
      applied.thinkingLevel = settings.thinkingLevel;
    }
    const appliedModel = applied.model;
    if (
      settings.model &&
      appliedModel &&
      appliedModel.reasoning !== false
    ) {
      try {
        const state = asState(await rpc.send({ type: "get_state" }));
        const thinkingLevel = state.thinkingLevel as ThinkingLevel | undefined;
        if (
          state.model?.provider === appliedModel.provider &&
          state.model.id === appliedModel.id &&
          thinkingLevel &&
          THINKING_LEVELS.includes(thinkingLevel)
        )
          applied.thinkingLevel = thinkingLevel;
      } catch (error) {
        // Model/Thinking writes were already acknowledged. A failed read must
        // neither make the following Prompt ambiguous nor claim an unconfirmed
        // clamped value; the next Runtime refresh can repair the projection.
        console.warn(
          `[Pi Chat] 切换模型后无法确认 Thinking 强度${sessionId ? `（Session ${sessionId}）` : ""}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return applied;
  }


  return applyTurnSettings;
}
