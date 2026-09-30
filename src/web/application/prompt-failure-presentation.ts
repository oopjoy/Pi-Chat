import type { PiMessage } from "../../shared/types";
import type { DraftPaneAuthority, PaneAuthoritySnapshot } from "./pane-authority";
import type { ConversationPaneAction } from "../state/conversation-pane";

export interface PromptFailurePresentationHost<TPaneAuthority, TDraftAuthority> {
  commitPane(authority: TPaneAuthority, action: ConversationPaneAction): boolean;
  commitDraft(authority: TDraftAuthority, action: ConversationPaneAction): boolean;
  scheduleSidebarRefresh(): void;
  showNotice(message: string): void;
  showError(message: string): void;
}

export function presentPromptFailure<TPaneAuthority extends PaneAuthoritySnapshot, TDraftAuthority extends DraftPaneAuthority>(
  input: {
    sessionId: string;
    paneAuthority: TPaneAuthority | null;
    draftAuthority: TDraftAuthority | null;
    rejectionMessages?: PiMessage[] | ((current: PiMessage[]) => PiMessage[]);
    stoppedSteerRejection: boolean;
    stateStreaming: boolean;
    promptAcceptedByEvent: boolean;
    resultPending: boolean;
    causeMessage: string;
  },
  host: PromptFailurePresentationHost<TPaneAuthority, TDraftAuthority>,
): boolean {
  const visible = input.paneAuthority
    ? host.commitPane(input.paneAuthority, {
        type: "PROMPT_REJECTED",
        sessionId: input.sessionId,
        ...(input.rejectionMessages ? { messages: input.rejectionMessages } : null),
        ...(input.stoppedSteerRejection ? { isStreaming: false } : null),
        toolStatus:
          input.stoppedSteerRejection || (!input.stateStreaming && !input.promptAcceptedByEvent)
            ? ""
            : undefined,
      })
    : input.draftAuthority
      ? host.commitDraft(input.draftAuthority, { type: "DRAFT_PROMPT_REJECTED" })
      : false;
  if (!input.paneAuthority) host.scheduleSidebarRefresh();
  if (visible) {
    if (input.resultPending) host.showNotice(input.causeMessage);
    else host.showError(input.causeMessage);
  }
  return visible;
}
