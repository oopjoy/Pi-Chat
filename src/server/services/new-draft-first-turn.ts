import type { PiState, PromptImage, PromptSettingsSnapshot, SessionRuntimeReadyData, SessionSummary } from "../../shared/types.js";
import type { AppliedTurnSettings } from "../runtime-pool.js";
import { RpcRequestTimeoutError } from "../rpc-client.js";

export interface NewDraftFirstTurnPorts {
  requireControl(): void;
  applySettings(): Promise<AppliedTurnSettings>;
  isPartialSettingsError(error: unknown): error is { applied: AppliedTurnSettings };
  rememberPartialSettings(applied: AppliedTurnSettings): void;
  rememberSettings(applied: AppliedTurnSettings): void;
  assertCurrent(): void;
  extensionCommand(message: string): Promise<{ name: string; description?: string } | null>;
  syncGate(): Promise<void>;
  setRunning(running: boolean): void;
  traceAdmitted(promptId: string): void;
  broadcastActivity(): void;
  sendPrompt(message: string, images: PromptImage[], promptId: string): Promise<void>;
  sendExtensionPrompt(message: string): Promise<void>;
  readState(): Promise<PiState>;
  adoptExtensionState(state: PiState): Promise<void>;
  noteUserPrompt(): void;
  notifyPromptAccepted(promptId: string): void;
  traceDeliveryUncertain(promptId: string): void;
  readyData(): SessionRuntimeReadyData;
  sessionData(): SessionSummary;
  runtimeTurnActive(): boolean;
  onFailure(): void;
}

export interface NewDraftFirstTurnInput {
  message: string;
  images: PromptImage[];
  promptId: string;
  settings?: PromptSettingsSnapshot;
  extensionGateMessage?: string;
}

export type NewDraftFirstTurnResult = {
  ready: SessionRuntimeReadyData;
  session: SessionSummary;
  promptId?: string;
  deliveryUncertain: boolean;
  extension?: { name: string; description?: string; isStreaming: boolean };
};

/** Complete the first Prompt transaction for an already-leased New draft. */
export async function dispatchNewDraftFirstTurn(
  ports: NewDraftFirstTurnPorts,
  input: NewDraftFirstTurnInput,
): Promise<NewDraftFirstTurnResult> {
  try {
    ports.requireControl();
    let applied: AppliedTurnSettings;
    try {
      applied = await ports.applySettings();
    } catch (error) {
      if (ports.isPartialSettingsError(error)) ports.rememberPartialSettings(error.applied);
      throw error;
    }
    ports.rememberSettings(applied);
    ports.assertCurrent();
    const extension = input.message
      ? await ports.extensionCommand(input.message)
      : null;
    ports.assertCurrent();
    if (extension && input.images.length)
      throw new Error("Extension 指令不能同时附加图片");
    await ports.syncGate();
    ports.assertCurrent();
    ports.setRunning(true);
    if (input.promptId) ports.traceAdmitted(input.promptId);
    ports.broadcastActivity();

    let uncertain = false;
    try {
      if (extension) {
        await ports.sendExtensionPrompt(input.message);
        const state = await ports.readState();
        await ports.adoptExtensionState(state);
        ports.noteUserPrompt();
        return {
          ready: ports.readyData(),
          session: ports.sessionData(),
          deliveryUncertain: false,
          extension: {
            name: extension.name,
            description: extension.description,
            isStreaming: ports.runtimeTurnActive(),
          },
        };
      }
      await ports.sendPrompt(input.message || "请查看这些图片。", input.images, input.promptId);
      ports.notifyPromptAccepted(input.promptId);
    } catch (error) {
      if (!(error instanceof RpcRequestTimeoutError) || !error.outcomeUnknown) throw error;
      uncertain = true;
      if (input.promptId) ports.traceDeliveryUncertain(input.promptId);
      ports.notifyPromptAccepted(input.promptId);
    }
    return {
      ready: ports.readyData(),
      session: ports.sessionData(),
      ...(input.promptId ? { promptId: input.promptId } : null),
      deliveryUncertain: uncertain,
    };
  } catch (error) {
    ports.onFailure();
    throw error;
  }
}
