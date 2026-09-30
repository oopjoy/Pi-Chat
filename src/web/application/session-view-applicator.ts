import type { ExtensionUiRequest, GateMode, PiMessage, QueuedPrompt, SessionSummary, SessionViewData, SlashCommand } from "../../shared/types";
import { emptyConversationPane, type ConversationPaneAction } from "../state/conversation-pane";
import { type LocalUserTurn, type ProtectedTranscript } from "../lib/local-user-turn";
import type { recordBrowserStateDiagnostic } from "../lib/state-diagnostics";
import type { ActiveSessionViewDecision } from "./active-session-projection-writer";
import type { PaneAuthoritySnapshot } from "./pane-authority";
import { prepareSessionViewCommit } from "./session-view-commit";

export interface SessionViewApplicatorPorts {
  recordBrowserStateDiagnostic: typeof recordBrowserStateDiagnostic;
  confirmedDeleted(): ReadonlySet<string>;
  paneAuthorityCanCommit(authority: any): boolean;
  projectActiveSession(id: string): ActiveSessionViewDecision;
  reconcileActiveSession(id: string, active: boolean, authority: any): ActiveSessionViewDecision;
  completedCompaction(): ReadonlySet<string>;
  queueProjectionForView(id: string, queue: QueuedPrompt[] | undefined, paused: boolean, revision?: number): { queue: QueuedPrompt[]; paused: boolean; known: boolean };
  applySidebarQueueProjection(session: SessionSummary, queue: QueuedPrompt[], paused: boolean): SessionSummary;
  commitSessionViewCache(view: SessionViewData, authority: any): SessionViewData | undefined;
  recordRejectedView(id: string, reason: string, authority: any): void;
  recordAcceptedView(id: string, authority: any): void;
  reconcileServerPendingPrompt(view: SessionViewData): void;
  reconcileServerPendingSteers(view: SessionViewData): void;
  clearStoppingForSession(id: string): void;
  viewedSessionId(): string;
  clearTerminalAssistantMarker(id: string): void;
  clearUnseenReply(id: string): void;
  recordSourceTurnTotal(id: string, total: number): void;
  reconcileQueuedAdmissions(id: string, queue: QueuedPrompt[] | undefined): void;
  localTurns(id: string): LocalUserTurn[];
  promoteTurnsAbsentFromQueue(turns: LocalUserTurn[], ids: ReadonlySet<string>, active: boolean, known: boolean, blocked?: ReadonlySet<string>): LocalUserTurn[];
  cancellingQueueIds(id: string): ReadonlySet<string> | undefined;
  protectTranscriptWithLocalTurns(turns: LocalUserTurn[] | undefined, messages: PiMessage[], messageTotal: number | undefined, turnTotal: number | undefined, truncated: boolean, ids?: ReadonlySet<string>): ProtectedTranscript;
  rememberConfirmedQueueDispatchIds(id: string, before: LocalUserTurn[], pending: LocalUserTurn[], messages: PiMessage[], total: number | undefined, truncated: boolean): void;
  localTurnBelongsInTranscript(turn: LocalUserTurn): boolean;
  storeLocalTurns(id: string, turns: LocalUserTurn[]): void;
  deleteLocalTurns(id: string): void;
  updateGateMode(id: string, mode: GateMode | undefined, authority: any): void;
  extensionAuthority(id: string, authority: any): PaneAuthoritySnapshot;
  tryAutoAllowGate(request: ExtensionUiRequest, id: string, authority: PaneAuthoritySnapshot): boolean;
  commitPane(action: Extract<ConversationPaneAction, { type: "COMMIT_VIEW" }>): void;
  committedPaneCommandsFor(id: string): SlashCommand[];
  setRuntimeWarming(id: string, warming: boolean): void;
  clearPaneLoading(id: string): void;
  recordPaneCommit(view: SessionViewData): void;
  recordCommittedView(view: SessionViewData, paused: boolean): void;
  isSubagentView(id: string): boolean;
  reconcileSessionInventoryCurrent(sessions: SessionSummary[]): SessionSummary[];
  updateSessionSummary(session: SessionSummary): void;
}

/** Stable App callbacks supply typed sinks; the applicator owns no authority store. */
export function createSessionViewApplicator(host: SessionViewApplicatorPorts) {
  return function applySessionView(
    view: SessionViewData,
    authority: any,
    queueRequestRevision?: number,
  ): void {
    host.recordBrowserStateDiagnostic("projection", "session-view-received", {
      sessionId: view.session.id,
      details: {
        viewSource: view.viewSource || "unknown",
        stateStreaming: view.state.isStreaming,
        viewStreaming: view.isStreaming,
        sessionRunning: view.session.running === true,
        hasLive: Boolean(view.liveMessage),
        toolActive: Boolean(view.toolStatus),
        queuePaused: view.queuePaused === true,
        queueLength: view.queue?.length || 0,
        authorityPresent: Boolean(authority),
      },
    });
    const prepared = prepareSessionViewCommit(
      view,
      authority,
      queueRequestRevision,
      {
        isDeleted: (sessionId) => host.confirmedDeleted().has(sessionId),
        canCommit: (candidate) => !candidate || host.paneAuthorityCanCommit(candidate),
        projectActive: (sessionId, source, reportedActive, candidate) =>
          source === "browser-cache"
            ? host.projectActiveSession(sessionId)
            : host.reconcileActiveSession(sessionId, reportedActive, candidate),
        completedCompaction: (sessionId) => host.completedCompaction().has(sessionId),
        queueProjection: host.queueProjectionForView,
        applyQueueToSession: host.applySidebarQueueProjection,
        commitCache: (candidate, candidateAuthority) => host.commitSessionViewCache(candidate, candidateAuthority) || null,
        recordRejected: (sessionId, reason) => host.recordRejectedView(sessionId, reason, authority),
        recordAccepted: (sessionId) => host.recordAcceptedView(sessionId, authority),
      },
    );
    if (prepared.kind === "rejected") return;
    const sourceView = prepared.sourceView;
    const filteredQueue = prepared.queue;
    const queueKnown = prepared.queueKnown;
    host.reconcileServerPendingPrompt(sourceView);
    host.reconcileServerPendingSteers(sourceView);
    if (!sourceView.isStreaming) host.clearStoppingForSession(sourceView.session.id);
    if (sourceView.session.id !== host.viewedSessionId()) {
      host.clearTerminalAssistantMarker(sourceView.session.id);
      host.clearUnseenReply(sourceView.session.id);
    }
    host.recordSourceTurnTotal(
      sourceView.session.id,
      sourceView.turnTotal ?? sourceView.messages.filter((message) => message.role === "user").length,
    );
    host.reconcileQueuedAdmissions(sourceView.session.id, sourceView.queue);
    const viewLocalTurns = host.localTurns(sourceView.session.id);
    if (queueKnown)
      host.promoteTurnsAbsentFromQueue(
        viewLocalTurns,
        new Set(filteredQueue.map((item) => item.id)),
        Boolean(sourceView.isStreaming || sourceView.state.isStreaming || sourceView.session.running || sourceView.liveMessage || sourceView.toolStatus),
        queueKnown,
        host.cancellingQueueIds(sourceView.session.id),
      );
    const protectedTranscript = host.protectTranscriptWithLocalTurns(
      host.localTurns(sourceView.session.id),
      sourceView.messages,
      sourceView.messageTotal,
      sourceView.turnTotal,
      sourceView.messagesTruncated,
      queueKnown ? new Set(filteredQueue.map((item) => item.id)) : undefined,
    );
    host.rememberConfirmedQueueDispatchIds(
      sourceView.session.id,
      viewLocalTurns,
      protectedTranscript.pendingTurns,
      sourceView.messages,
      sourceView.turnTotal,
      sourceView.messagesTruncated,
    );
    if (protectedTranscript.pendingTurns.length) {
      protectedTranscript.pendingTurns.forEach((turn) => {
        turn.renderedInTranscript = host.localTurnBelongsInTranscript(turn);
      });
      host.storeLocalTurns(sourceView.session.id, protectedTranscript.pendingTurns);
    } else host.deleteLocalTurns(sourceView.session.id);
    const resolvedView = protectedTranscript.pendingTurns.length
      ? { ...sourceView, messages: protectedTranscript.messages, messageTotal: protectedTranscript.messageTotal, turnTotal: protectedTranscript.turnTotal }
      : sourceView;
    host.updateGateMode(sourceView.session.id, view.gateMode, authority);
    const nextRuntimeStatus = resolvedView.runtimeStatus || (resolvedView.isActive ? "active" : "view-only");
    const pending = view.pendingExtensionRequest || null;
    const paneAuthority = host.extensionAuthority(view.session.id, authority);
    const extensionRequest = pending && !host.tryAutoAllowGate(pending, view.session.id, paneAuthority) ? pending : null;
    host.commitPane({
      type: "COMMIT_VIEW",
      pane: {
        ...emptyConversationPane(),
        identity: { kind: "session", sessionId: resolvedView.session.id },
        piState: { ...resolvedView.state, sessionName: resolvedView.session.name },
        messages: resolvedView.messages,
        forkOrigin: resolvedView.forkOrigin,
        messageTotal: resolvedView.messageTotal,
        turnTotal: resolvedView.turnTotal ?? resolvedView.messages.filter((message) => message.role === "user").length,
        visibleTurnCount: resolvedView.visibleTurnCount ?? resolvedView.messages.filter((message) => message.role === "user").length,
        messagesTruncated: resolvedView.messagesTruncated,
        runStartedAt: resolvedView.session.activity?.runStartedAt ?? null,
        lastRunDurationMs: resolvedView.session.activity?.lastRunDurationMs ?? null,
        stats: resolvedView.stats,
        liveMessage: resolvedView.liveMessage || null,
        commands: resolvedView.commands?.length
          ? resolvedView.commands
          : host.committedPaneCommandsFor(resolvedView.session.id),
        queue: resolvedView.queue || [],
        queuePaused: prepared.queuePaused,
        toolStatus: resolvedView.toolStatus || "",
        extensionRequest,
        runtimeStatus: nextRuntimeStatus,
        control: {
          controlOwner: sourceView.controlOwner ?? sourceView.session.controlOwner,
          controlledByThisWindow: sourceView.controlledByThisWindow ?? sourceView.session.controlledByThisWindow,
        },
        gateAvailableOverride: typeof view.gateAvailable === "boolean" ? view.gateAvailable : null,
      },
    });
    if (nextRuntimeStatus === "active") host.setRuntimeWarming(resolvedView.session.id, false);
    host.clearPaneLoading(resolvedView.session.id);
    host.recordPaneCommit(resolvedView);
    host.recordCommittedView(resolvedView, prepared.queuePaused);
    const isSubagentView = host.isSubagentView(resolvedView.session.id);
    if (!isSubagentView && resolvedView.session.messageCount > 0) {
      const summary = host.reconcileSessionInventoryCurrent([resolvedView.session])[0];
      if (!summary) return;
      host.updateSessionSummary(summary);
    }
  };
}
