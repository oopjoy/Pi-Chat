import type { GateMode, PiState, PromptImage } from "../../shared/types.js";

export interface PromptExtensionAdmissionPorts {
  clearPromptDiagnostic(sessionId: string): void;
  newOutcomeToken(): string;
  sendPrompt(message: string, outcomeToken: string): Promise<void>;
  outcomeUnknown(error: unknown): boolean;
  markOutcomePending(sessionId: string, error: unknown, token: string): void;
  rethrowResultPending(error: unknown, operation: string, fence?: boolean): never;
  requestedGateMode(message: string, commandName: string): GateMode | null;
  setGateMode(mode: GateMode): void;
  noteUserPrompt(promptAt: number): void;
  readState(): Promise<PiState>;
  confirmState(state: PiState): Promise<void>;
}

export type PromptExtensionAdmissionResult = {
  status: 202 | 400;
  body: Record<string, unknown>;
};

/** Extension commands are a single prompt write plus a read-only state confirm. */
export async function admitPromptExtension(
  ports: PromptExtensionAdmissionPorts,
  input: {
    sessionId: string;
    message: string;
    images: PromptImage[];
    commandName: string;
    commandDescription: string;
    promptAt: number;
  },
): Promise<PromptExtensionAdmissionResult> {
  if (input.images.length)
    return { status: 400, body: { error: "Extension 指令不能同时附加图片" } };

  // Extension commands are not ordinary Agent turns. Drop ambiguous Prompt
  // evidence before their write so lifecycle frames cannot bind to an older ID.
  ports.clearPromptDiagnostic(input.sessionId);
  const outcomeToken = ports.newOutcomeToken();
  try {
    await ports.sendPrompt(input.message, outcomeToken);
  } catch (error) {
    if (ports.outcomeUnknown(error)) {
      ports.markOutcomePending(input.sessionId, error, outcomeToken);
      ports.rethrowResultPending(error, "Extension 指令");
    }
    throw error;
  }

  const requestedGateMode = ports.requestedGateMode(input.message, input.commandName);
  if (requestedGateMode) ports.setGateMode(requestedGateMode);
  ports.noteUserPrompt(input.promptAt);

  let state: PiState;
  try {
    state = await ports.readState();
  } catch (error) {
    // Read-only confirmation must not create a new mutation fence after the
    // Extension write itself was acknowledged.
    if (ports.outcomeUnknown(error))
      ports.rethrowResultPending(error, "确认 Extension 指令", false);
    throw error;
  }
  await ports.confirmState(state);
  return {
    status: 202,
    body: {
      accepted: true,
      queued: false,
      extension: true,
      command: input.commandName,
      description: input.commandDescription,
      isStreaming: state.isStreaming,
    },
  };
}
