import type { BootstrapData, ExtensionUiRequest, SessionViewData } from "../../shared/types";
import { emptyConversationPane } from "../state/conversation-pane";
import { applySidebarQueueProjection } from "./session-summary-reconciliation";

export function createBootstrapCommit(host: Record<string, any>) {
  return function applyBootstrap(
    data: BootstrapData,
    authority: any,
    queueRequestRevision: number | undefined,
    cacheAuthority: any,
  ): void {
    if (authority && !host.paneAuthorityCanCommit(authority)) {
      host.recordRejected("stale-pane-authority");
      return;
    }
    const activeViewId = data.activeSessionId || data.sessions.find((item: any) => item.active)?.id || "";
    host.recordReceived(activeViewId, data);
    host.recordAccepted(activeViewId, authority);
    const bootstrapProjection = activeViewId
      ? queueRequestRevision === undefined
        ? host.acceptQueueProjection(activeViewId, data.queue, data.queuePaused)
        : host.acceptQueueProjectionIfCurrent(activeViewId, queueRequestRevision, data.queue, data.queuePaused)
      : { queue: data.queue, paused: data.queuePaused };
    const bootstrapQueue = bootstrapProjection.queue;
    const bootstrapSessions = data.sessions.map((session: any) =>
      session.id === activeViewId
        ? applySidebarQueueProjection(session, bootstrapQueue, bootstrapProjection.paused)
        : session,
    );
    const activeViewSession = bootstrapSessions.find((session: any) => session.id === activeViewId);
    const sourceView = activeViewSession
      ? host.commitSessionViewCache({
          session: activeViewSession,
          state: data.state,
          messages: data.messages,
          forkOrigin: data.forkOrigin,
          messageTotal: data.messageTotal ?? data.messages.length,
          turnTotal: data.turnTotal,
          visibleTurnCount: data.visibleTurnCount,
          messagesTruncated: data.messagesTruncated === true,
          isActive: true,
          runtimeStatus: "active",
          isStreaming: data.state.isStreaming,
          liveMessage: data.liveMessage,
          toolStatus: data.toolStatus,
          stats: data.stats,
          queue: bootstrapQueue,
          queuePaused: bootstrapProjection.paused,
          commands: data.commands,
          pendingExtensionRequest: data.pendingExtensionRequest,
          pendingPrompt: data.pendingPrompt,
          pendingSteers: data.pendingSteers,
          pendingSteerRevision: data.pendingSteerRevision,
        }, authority || cacheAuthority)
      : null;
    if (activeViewSession && !sourceView) {
      host.recordRejected(host.confirmedDeleted().has(activeViewId) ? "session-deleted" : "stale-cache-authority");
      return;
    }
    if (sourceView) {
      host.reconcileServerPendingPrompt(sourceView);
      host.reconcileServerPendingSteers(sourceView);
    }
    host.reconcileQueuedAdmissions(activeViewId, sourceView?.queue || bootstrapQueue);
    const bootstrapLocalTurns = host.localTurns(activeViewId);
    host.promoteTurnsAbsentFromQueue(
      bootstrapLocalTurns,
      new Set(bootstrapQueue.map((item: any) => item.id)),
      Boolean(sourceView?.isStreaming || sourceView?.state.isStreaming || sourceView?.session.running || sourceView?.liveMessage || sourceView?.toolStatus),
      Boolean(activeViewId),
      host.cancellingQueueIds(activeViewId),
    );
    const protectedTranscript = host.protectTranscriptWithLocalTurns(
      host.localTurns(activeViewId),
      sourceView?.messages || data.messages,
      sourceView?.messageTotal ?? data.messageTotal,
      sourceView?.turnTotal ?? data.turnTotal,
      sourceView?.messagesTruncated ?? data.messagesTruncated === true,
      new Set(bootstrapQueue.map((item: any) => item.id)),
    );
    host.rememberConfirmedQueueDispatchIds(
      activeViewId,
      bootstrapLocalTurns,
      protectedTranscript.pendingTurns,
      sourceView?.messages || data.messages,
      sourceView?.turnTotal ?? data.turnTotal,
      sourceView?.messagesTruncated ?? data.messagesTruncated === true,
    );
    if (protectedTranscript.pendingTurns.length) {
      protectedTranscript.pendingTurns.forEach((turn: any) => { turn.renderedInTranscript = host.localTurnBelongsInTranscript(turn); });
      host.storeLocalTurns(activeViewId, protectedTranscript.pendingTurns);
    } else host.deleteLocalTurns(activeViewId);
    host.applyBootstrapMetadata({ ...data, sessions: bootstrapSessions, queue: bootstrapQueue, queuePaused: bootstrapProjection.paused }, cacheAuthority);
    if (activeViewId) host.updateGateMode(activeViewId, data.gateMode, authority || cacheAuthority);
    if (!activeViewId) {
      host.commitPane({ type: "RESET_DRAFT", model: data.state.model, thinkingLevel: data.state.thinkingLevel, draftWorkspaceCwd: data.workspaceCwd });
      host.recordCommitted("draft");
      host.confirmPrimaryCapabilitySnapshot(data, data.state.model, cacheAuthority);
      return;
    }
    const staged = host.stagedPreference(activeViewId);
    const committedModel = staged?.model !== undefined ? staged.model : data.state.model;
    host.commitPane({
      type: "COMMIT_BOOTSTRAP",
      pane: {
        ...emptyConversationPane(),
        identity: { kind: "session", sessionId: activeViewId },
        piState: data.state,
        messages: protectedTranscript.messages,
        forkOrigin: data.forkOrigin,
        messageTotal: protectedTranscript.messageTotal,
        turnTotal: protectedTranscript.turnTotal,
        runStartedAt: activeViewSession?.activity?.runStartedAt ?? null,
        lastRunDurationMs: activeViewSession?.activity?.lastRunDurationMs ?? null,
        visibleTurnCount: data.visibleTurnCount ?? protectedTranscript.messages.filter((message: any) => message.role === "user").length,
        messagesTruncated: data.messagesTruncated === true,
        stats: data.stats,
        liveMessage: sourceView?.liveMessage || data.liveMessage || null,
        commands: data.commands.length ? data.commands : host.committedPaneCommandsFor(activeViewId),
        queue: bootstrapQueue,
        queuePaused: bootstrapProjection.paused,
        toolStatus: data.toolStatus || "",
        extensionRequest: data.pendingExtensionRequest || null,
        runtimeStatus: "active",
        control: { controlOwner: data.controlOwner, controlledByThisWindow: data.controlledByThisWindow },
      },
    });
    host.recordCommitted(activeViewId);
    host.confirmPrimaryCapabilitySnapshot(data, committedModel, cacheAuthority);
  };
}
