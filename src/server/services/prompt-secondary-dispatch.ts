import type { PromptImage, PromptSettingsSnapshot } from "../../shared/types.js";
import type { AppliedTurnSettings } from "../runtime-pool.js";
import { RpcRequestTimeoutError } from "../rpc-client.js";

export interface SecondaryPromptDispatchPorts {
  applySettings(): Promise<AppliedTurnSettings>;
  isPartialSettingsError(error: unknown): error is { applied: AppliedTurnSettings };
  rememberPartialSettings(applied: AppliedTurnSettings): void;
  rememberSettings(applied: AppliedTurnSettings): void;
  assertCurrent(): void;
  syncGate(): Promise<void>;
  setRunning(running: boolean): void;
  traceAdmitted(): void;
  broadcastActivity(): void;
  sendPrompt(message: string, images: PromptImage[]): Promise<void>;
  outcomeUnknown(error: unknown): boolean;
  traceDeliveryUncertain(): void;
  notifyAccepted(settings?: PromptSettingsSnapshot): void;
  onFailure(): void;
}

export type SecondaryPromptDispatchResult = {
  status: 202;
  body: { accepted: true; queued: false; promptId: string; deliveryUncertain?: boolean };
};

/** Prepare and dispatch one direct Prompt to an already-admitted Secondary. */
export async function dispatchSecondaryPrompt(
  ports: SecondaryPromptDispatchPorts,
  input: {
    message: string;
    images: PromptImage[];
    promptId: string;
    settings?: PromptSettingsSnapshot;
  },
): Promise<SecondaryPromptDispatchResult> {
  try {
    let applied: AppliedTurnSettings;
    try {
      applied = await ports.applySettings();
    } catch (error) {
      if (ports.isPartialSettingsError(error)) ports.rememberPartialSettings(error.applied);
      throw error;
    }
    ports.rememberSettings(applied);
    ports.assertCurrent();
    await ports.syncGate();
    ports.assertCurrent();
    ports.setRunning(true);
    ports.traceAdmitted();
    ports.broadcastActivity();
    try {
      await ports.sendPrompt(input.message || "请查看这些图片。", input.images);
    } catch (error) {
      if (!(error instanceof RpcRequestTimeoutError) || !ports.outcomeUnknown(error)) throw error;
      ports.traceDeliveryUncertain();
      ports.notifyAccepted(input.settings);
      return {
        status: 202,
        body: { accepted: true, queued: false, promptId: input.promptId, deliveryUncertain: true },
      };
    }
    ports.notifyAccepted(input.settings);
    return {
      status: 202,
      body: { accepted: true, queued: false, promptId: input.promptId },
    };
  } catch (error) {
    ports.onFailure();
    throw error;
  }
}
