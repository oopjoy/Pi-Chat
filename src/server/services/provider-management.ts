import type { ModelManager } from "../model-manager.js";
import { asState } from "../pi-data.js";
import { probeProviderModels } from "../provider-model-probe.js";

export interface ProviderManagementPorts {
  manager: Pick<ModelManager, "getCustomProvider" | "addProvider" | "removeProvider" | "updateProvider" | "storedProviderApiKey">;
  withLifecycle<T>(description: string, mutation: () => Promise<T>): Promise<T>;
  withModelFileTransaction<T>(mutation: () => Promise<T>): Promise<T>;
  primaryState(): Promise<Record<string, unknown>>;
  secondaryStates(): Promise<Array<Record<string, unknown> | null>>;
  bootstrap(): Promise<unknown>;
}


/** The ModelManager owns models.json; this use-case only coordinates safe writes. */
export function createProviderManagement(ports: ProviderManagementPorts) {
  return {
    get: (provider: string) => ports.manager.getCustomProvider(provider),
    probe: async (body: Record<string, unknown>) => {
      const typedKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      const provider = typeof body.provider === "string" ? body.provider.trim() : "";
      const apiKey = typedKey || (provider ? await ports.manager.storedProviderApiKey(provider) : "") || "";
      return {
        models: await probeProviderModels({
          baseUrl: String(body.baseUrl || ""),
          api: String(body.api || "openai-completions"),
          apiKey,
        }),
      };
    },
    add: (body: Record<string, unknown>) => ports.withLifecycle("添加 Provider", async () => {
      await ports.withModelFileTransaction(() => ports.manager.addProvider(body));
      return ports.bootstrap();
    }),
    // Deletion is a models.json edit, so it is always allowed. A conversation
    // that still selects a model from this Provider keeps that stale route and
    // reports "当前模型不存在" on its next send, which points the user at the
    // model selector instead of trapping them behind an unreachable dialog.
    remove: (provider: string) => ports.withLifecycle("删除 Provider", async () => {
      await ports.withModelFileTransaction(() => ports.manager.removeProvider(provider));
      return ports.bootstrap();
    }),
    update: (provider: string, body: Record<string, unknown>) =>
      ports.withLifecycle("更新 Provider 配置", async () => {
        const primaryState = await ports.primaryState();
        const secondaryStates = await ports.secondaryStates();
        const proposedModels = body.models;
        const proposedIds = Array.isArray(proposedModels)
          ? new Set(proposedModels.flatMap((model) =>
              model && typeof model === "object"
              && typeof (model as Record<string, unknown>).id === "string"
                ? [(model as Record<string, unknown>).id as string]
                : [],
            ))
          : null;
        const invalidatesActiveModel = proposedIds
          && [primaryState, ...secondaryStates].some((response) => {
            if (!response) return false;
            const model = asState(response).model;
            return model?.provider === provider && !proposedIds.has(model.id);
          });
        if (invalidatesActiveModel)
          throw new Error("请先在所有已启动对话中切换到其他模型，再重命名或删除当前模型");
        await ports.withModelFileTransaction(() => ports.manager.updateProvider(provider, body));
        return ports.bootstrap();
      }),
  };
}
