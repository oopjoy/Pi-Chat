import type { GateMode, PromptImage, PromptSettingsSnapshot, QueuedPrompt } from "../../shared/types.js";

export interface PromptQueueAdmissionPorts {
  isBusy(): boolean;
  assertCanEnqueue(images: PromptImage[]): string | null;
  enqueue(
    message: string,
    images: PromptImage[],
    promptAt: number,
    gateMode?: GateMode,
    settings?: PromptSettingsSnapshot,
    clientPromptOperationId?: string,
  ): QueuedPrompt;
  supersedePendingSettings(settings?: PromptSettingsSnapshot): void;
  publicQueue(): QueuedPrompt[];
  traceAdmitted(queueId: string): void;
  traceQueued(queueId: string): void;
  noteUserPrompt(promptAt: number): void;
}

export type PromptQueueAdmissionResult =
  | { kind: "not-busy" }
  | { kind: "conflict"; error: string }
  | { kind: "queued"; queue: QueuedPrompt[]; item: QueuedPrompt };

/** Admit one immutable Prompt snapshot into an owner-provided FIFO Queue. */
export function admitPromptToQueue(
  ports: PromptQueueAdmissionPorts,
  input: {
    message: string;
    images: PromptImage[];
    promptAt: number;
    gateMode?: GateMode;
    settings?: PromptSettingsSnapshot;
    clientPromptOperationId?: string;
  },
): PromptQueueAdmissionResult {
  if (!ports.isBusy()) return { kind: "not-busy" };
  const enqueueError = ports.assertCanEnqueue(input.images);
  if (enqueueError) return { kind: "conflict", error: enqueueError };
  const item = ports.enqueue(
    input.message,
    input.images,
    input.promptAt,
    input.gateMode,
    input.settings,
    input.clientPromptOperationId,
  );
  ports.supersedePendingSettings(input.settings);
  ports.traceAdmitted(item.id);
  ports.traceQueued(item.id);
  ports.noteUserPrompt(input.promptAt);
  return { kind: "queued", queue: ports.publicQueue(), item };
}
