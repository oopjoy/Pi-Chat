/** A bounded, request-addressed witness of Pi's post-preflight user message. */
export interface PromptPersistenceReceipt {
  version: 1;
  timestamp: number;
  payloadFingerprint: string;
}

/**
 * The process-local RPC adapter adds this to the existing successful prompt
 * response. Queued/handled commands and legacy Pi responses carry no witness.
 * Acceptance is not persistence: the pending overlay still waits for a JSONL
 * row with this exact timestamp and payload fingerprint.
 */
export function promptPersistenceReceipt(response: Record<string, unknown>): PromptPersistenceReceipt | undefined {
  if (response.command !== "prompt" || response.success !== true) return undefined;
  const data = response.data;
  if (!data || typeof data !== "object" || !("disposition" in data) || data.disposition !== "started") return undefined;
  const receipt = "piChatUserMessage" in data ? data.piChatUserMessage : undefined;
  if (!receipt || typeof receipt !== "object") return undefined;
  if (!("version" in receipt) || receipt.version !== 1
    || !("timestamp" in receipt) || typeof receipt.timestamp !== "number"
    || !Number.isFinite(receipt.timestamp) || receipt.timestamp < 0
    || !("payloadFingerprint" in receipt) || typeof receipt.payloadFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(receipt.payloadFingerprint)) return undefined;
  return { version: 1, timestamp: receipt.timestamp, payloadFingerprint: receipt.payloadFingerprint };
}
