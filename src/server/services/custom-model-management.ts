import type { ModelInfo, PiState } from "../../shared/types.js";
import type { ModelManager } from "../model-manager.js";

export interface CustomModelManagementPorts {
  manager: Pick<ModelManager, "getCustomConfig" | "add" | "update" | "remove">;
  withLifecycle<T>(description: string, mutation: () => Promise<T>): Promise<T>;
  withModelFileTransaction<T>(mutation: () => Promise<T>): Promise<T>;
  primaryState(): Promise<PiState>;
  primaryTurnActive(): boolean;
  setPrimaryModel(provider: string, modelId: string): Promise<void>;
  bootstrap(): Promise<unknown>;
}

/** Custom-model use-case owner; ModelManager remains models.json authority. */
export function createCustomModelManagement(ports: CustomModelManagementPorts) {
  return {
    get: (provider: string, modelId: string) => ports.manager.getCustomConfig(provider, modelId),
    add: (body: unknown) => ports.withLifecycle("添加模型", async () => {
      await ports.withModelFileTransaction(() => ports.manager.add(body));
      return ports.bootstrap();
    }),
    remove: async (provider: string, modelId: string) => {
      const state = await ports.primaryState();
      if (state.model?.provider === provider && state.model.id === modelId)
        throw new Error("请先切换到其他模型，再删除当前模型");
      return ports.withLifecycle("删除模型", async () => {
        await ports.withModelFileTransaction(() => ports.manager.remove(provider, modelId));
        return ports.bootstrap();
      });
    },
    update: (provider: string, modelId: string, body: unknown) =>
      ports.withLifecycle("更新模型配置", async () => {
        const state = await ports.primaryState();
        const wasActive = state.model?.provider === provider && state.model.id === modelId;
        const updated = await ports.withModelFileTransaction(() => ports.manager.update(provider, modelId, body));
        if (
          wasActive
          && !ports.primaryTurnActive()
          && (updated.provider !== provider || updated.id !== modelId)
        ) await ports.setPrimaryModel(updated.provider, updated.id);
        return ports.bootstrap();
      }),
  };
}
