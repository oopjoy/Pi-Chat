import type { PromptAcceptance } from "../prompt-scheduler.js";

export interface PrimaryPromptDispatchPorts {
  sendPrompt(): Promise<PromptAcceptance>;
  traceAdmitted(): void;
  traceDeliveryUncertain(): void;
}

export type PrimaryPromptDispatchResult = {
  status: 202;
  body: { accepted: true; queued: false; promptId: string; deliveryUncertain?: boolean };
};

/** Publish one already-admitted Primary Prompt acceptance. */
export async function dispatchPrimaryPrompt(
  ports: PrimaryPromptDispatchPorts,
  promptId: string,
): Promise<PrimaryPromptDispatchResult> {
  ports.traceAdmitted();
  const acceptance = await ports.sendPrompt();
  const uncertain = acceptance === "unknown";
  if (uncertain) ports.traceDeliveryUncertain();
  return {
    status: 202,
    body: {
      accepted: true,
      queued: false,
      promptId,
      ...(uncertain ? { deliveryUncertain: true } : null),
    },
  };
}
