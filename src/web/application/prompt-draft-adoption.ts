import type { InitialPromptData, SessionViewData } from "../../shared/types";
import type { DraftPaneAuthority } from "./pane-authority";
import type { ConversationPaneAction } from "../state/conversation-pane";

export interface DraftAdoptionHost<TSessionAuthority> {
  draftAuthorityCanCommit(authority: DraftPaneAuthority): boolean;
  applySessionView(view: SessionViewData, authority: DraftPaneAuthority): void;
  capturePaneAuthority(sessionId: string): TSessionAuthority;
  commitPane(authority: TSessionAuthority, action: ConversationPaneAction): boolean;
  commitSessionViewCache(view: SessionViewData, authority: DraftPaneAuthority): void;
}

export function initialDraftSessionViewFromResult(initial: InitialPromptData): SessionViewData {
  return {
    session: initial.session,
    state: initial.state,
    messages: [],
    messageTotal: 0,
    turnTotal: 0,
    visibleTurnCount: 0,
    messagesTruncated: false,
    isActive: true,
    runtimeStatus: "active",
    isStreaming: true,
    queue: [],
    queuePaused: false,
    gateMode: initial.gateMode,
  };
}

export function adoptDraftSessionView<TSessionAuthority>(input: {
  initial: InitialPromptData;
  targetSessionId: string;
  draftAuthority: DraftPaneAuthority;
  host: DraftAdoptionHost<TSessionAuthority>;
}): { view: SessionViewData; paneAuthority?: TSessionAuthority } {
  const view = initialDraftSessionViewFromResult(input.initial);
  if (input.host.draftAuthorityCanCommit(input.draftAuthority)) {
    input.host.applySessionView(view, input.draftAuthority);
    const paneAuthority = input.host.capturePaneAuthority(input.targetSessionId);
    input.host.commitPane(paneAuthority, {
      type: "PROMPT_PREPARING",
      target: { kind: "session", sessionId: input.targetSessionId },
      status: "正在等待 Pi 处理…",
      clearPending: true,
    });
    return { view, paneAuthority };
  }
  input.host.commitSessionViewCache(view, input.draftAuthority);
  return { view };
}
