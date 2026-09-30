import type { GateMode, SlashCommand } from "../../shared/types";
import type { PaneAuthoritySnapshot } from "./pane-authority";
import type { ConversationPaneAction } from "../state/conversation-pane";
import { extensionExecutionNotice } from "../lib/extension-notice";

export interface PromptAcknowledgementHost {
  commitPane(authority: PaneAuthoritySnapshot, action: ConversationPaneAction): boolean;
  protectLocalTurn(): void;
  updateGateMode(sessionId: string, mode: GateMode, authority: PaneAuthoritySnapshot): void;
  showNotice(message: string): void;
  composerCommands: SlashCommand[];
  previousToolStatus: string;
  alreadyStreaming: boolean;
}

type PromptResult = {
  extension?: boolean;
  command?: string;
  description?: string;
  isStreaming?: boolean;
  steered?: boolean;
  deliveryUncertain?: boolean;
};

/** Apply extension/Steer acknowledgement effects without owning Pane state. */
export function reconcileSpecialPromptAcknowledgement(input: {
  result: PromptResult;
  message: string;
  sessionId: string;
  authority: PaneAuthoritySnapshot;
  gateModeFromCommand: (message: string) => GateMode | null;
}, host: PromptAcknowledgementHost): boolean {
  if (input.result.extension) {
    host.commitPane(input.authority, {
      type: "PROMPT_ACKNOWLEDGED",
      sessionId: input.sessionId,
      isStreaming: input.result.isStreaming,
      toolStatus: host.alreadyStreaming ? host.previousToolStatus : "",
    });
    const gateMode = input.result.command === "gate"
      ? input.gateModeFromCommand(input.message)
      : null;
    if (gateMode) host.updateGateMode(input.sessionId, gateMode, input.authority);
    host.showNotice(extensionExecutionNotice(
      input.message,
      input.result.command || "extension",
      input.result.description
        ? [
            ...host.composerCommands,
            {
              name: input.result.command || "extension",
              description: input.result.description,
              source: "extension",
            },
          ]
        : host.composerCommands,
    ));
    return true;
  }
  if (input.result.steered) {
    host.protectLocalTurn();
    host.commitPane(input.authority, {
      type: "PROMPT_ACKNOWLEDGED",
      sessionId: input.sessionId,
      isStreaming: true,
      toolStatus: host.previousToolStatus,
    });
    host.showNotice(
      input.result.deliveryUncertain
        ? "Steer 已交给 Pi，正在确认执行状态；请勿重复发送"
        : "Steer 已送达 Pi",
    );
    return true;
  }
  return false;
}
