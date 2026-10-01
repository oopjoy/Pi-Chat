import type { ModelInfo, SessionStats, SessionSummary, SessionViewData } from "../../shared/types.js";
import { sessionViewFromCurrentProjection as sessionViewFromCurrentProjectionService } from "./session-hot-view.js";
import type { SessionFileSnapshot, SessionSettingsSnapshot, SessionUsageSnapshot } from "../session-index.js";

export function createSessionViewActions(host: Record<string, any>) {
  const {
    BUILTIN_COMMANDS,
    RECENT_TURN_WINDOW_SIZE,
    activeSessionId,
    activeSessionPath,
    applicationLifecycle,
    asSessionStats,
    currentCwd,
    lastPrimaryCommands,
    lastPrimaryMessages,
    lastPrimaryMessagesSessionId,
    lastPrimaryState,
    liveMessage,
    primaryGateMode,
    primaryPendingTerminalMessages,
    primaryPendingTerminalSessionId,
    primaryRpcGeneration,
    primarySummarySnapshot,
    projectColdSessionView,
    projectHotMemoryView,
    queuePaused,
    readColdSessionView,
    readSessionView,
    toolStatus,
  } = host;
  async function coldSessionView(
    id: string,
    session: SessionSummary,
    turnLimit: number,
    clientId: string,
  ): Promise<SessionViewData | null> {
    const snapshot = await host.options.sessions.snapshotForId?.(id);
    if (snapshot)
      return host.coldSessionViewFromSnapshot(id, session, snapshot, turnLimit, clientId);
    const messages = await host.options.sessions.messagesForId(id);
    if (!messages) return null;
    return host.coldSessionViewFromSnapshot(
      id,
      session,
      { messages, settings: {} },
      turnLimit,
      clientId,
    );
  }

  function coldSessionViewFromSnapshot(
    id: string,
    session: SessionSummary,
    snapshot: Pick<SessionFileSnapshot, "messages" | "settings" | "sourceMessageTotal" | "sourceTurnTotal" | "sourceMessagesTruncated" | "usageComplete"> & { usage?: SessionUsageSnapshot },
    turnLimit: number,
    clientId: string,
  ): SessionViewData {
    host.reconcilePendingAcceptedPrompts(id, snapshot.messages);
    return projectColdSessionView({
      modelFromSettings: (settings: any) => host.modelFromSessionSettings(settings),
      sessionActivity: (sessionId: any) => host.sessionActivity(sessionId),
      offlineStats: (sessionId: any, usage: any) => host.offlineStatsFromUsage(sessionId, usage),
      currentGateMode: (sessionId: any) => host.currentGateMode(sessionId),
      pendingRequest: (sessionId: any) => host.pendingRequestForSession(sessionId),
      controlState: (sessionId: any, browserId: any) => host.controlState(sessionId, browserId),
    }, { id, session, snapshot, turnLimit, clientId });
  }

  function hotMemoryView(
    id: string,
    turnLimit: number,
    clientId: string,
  ): SessionViewData | null {
    const runtime = id === host.activeSessionId ? null : host.runtimePool.get(id);
    const primary = id === host.activeSessionId && host.primaryReadReady();
    if (!runtime && !primary) return null;
    const summary = primary
      ? host.primarySummarySnapshot || {
          id,
          sessionId: host.lastPrimaryState.sessionId || id,
          name: host.lastPrimaryState.sessionName || "当前对话",
          preview: "",
          cwd: host.currentCwd,
          updatedAt: host.now(),
          messageCount: host.lastPrimaryState.messageCount || 0,
          active: true,
        }
      : runtime!.summarySnapshot || runtime!.draftSession;
    if (!summary) return null;
    const persisted = primary
      ? host.lastPrimaryMessagesSessionId === id ? host.lastPrimaryMessages : undefined
      : runtime!.messageSnapshot;
    const tail = primary
      ? host.primaryPendingTerminalSessionId === id ? host.primaryPendingTerminalMessages : []
      : runtime!.pendingTerminalMessages;
    const state = host.stateWithPendingPromptSettings(
      id,
      primary ? host.lastPrimaryState : runtime!.lastState || { model: null, isStreaming: runtime!.running },
    );
    const streaming = primary
      ? host.primaryTurnActive()
      : host.runtimeTurnActive(runtime!) || runtime!.dispatching;
    return projectHotMemoryView({
      modelFromSettings: (settings: any) => host.modelFromSessionSettings(settings),
      sessionActivity: (sessionId: any) => host.sessionActivity(sessionId),
      offlineStats: (sessionId: any, usage: any) => host.offlineStatsFromUsage(sessionId, usage),
      currentGateMode: (sessionId: any) => host.currentGateMode(sessionId),
      pendingRequest: (sessionId: any) => host.pendingRequestForSession(sessionId),
      controlState: (sessionId: any, browserId: any) => host.controlState(sessionId, browserId),
      touch: (sessionId: any) => { const target = host.runtimePool.get(sessionId); if (target) host.runtimePool.touch(target); },
      reconcilePendingPrompts: (sessionId: any, messages: any) => host.reconcilePendingAcceptedPrompts(sessionId, messages),
      pendingPrompt: (sessionId: any) => host.pendingPromptForSession(sessionId),
      pendingSteers: (sessionId: any) => host.pendingSteerProjection(sessionId),
      stateWithPendingPromptSettings: (sessionId: any, next: any) => host.stateWithPendingPromptSettings(sessionId, next),
      stateWithFastMode: (sessionId: any, next: any) => host.stateWithFastMode(sessionId, next),
    }, {
      id,
      turnLimit,
      clientId,
      primary,
      source: {
        summary,
        persisted,
        terminalTail: tail,
        state,
        streaming,
        liveMessage: primary ? host.liveMessage : runtime!.liveMessage,
        toolStatus: primary ? host.toolStatus : runtime!.toolStatus,
        stats: primary
          ? host.lastPrimaryStats?.sessionId === id ? host.lastPrimaryStats.value : undefined
          : runtime!.lastStats,
        queue: primary ? host.publicQueue() : host.publicQueue(runtime!.promptQueue),
        queuePaused: primary ? host.queuePaused : runtime!.queuePaused,
        commands: primary
          ? host.lastPrimaryCommands.length ? [...BUILTIN_COMMANDS, ...host.lastPrimaryCommands] : undefined
          : runtime!.commands?.length ? [...BUILTIN_COMMANDS, ...runtime!.commands] : undefined,
        gateMode: primary ? host.primaryGateMode : runtime!.gateMode,
        historyPending: !persisted,
        reconcilePending: !persisted || tail.length > 0 || (primary
          ? host.lastPrimaryStats?.sessionId !== id
          : !runtime!.statsKnown || !runtime!.commandsKnown),
      },
    });
  }

  async function coldSessionViewForId(
    id: string,
    turnLimit: number,
    clientId: string,
    includeForkOrigin = false,
  ): Promise<SessionViewData | null> {
    return readColdSessionView({
      index: host.options.sessions,
      activeSessionPath: () => host.activeSessionPath,
      currentCwd: () => host.currentCwd,
      projectSnapshot: (sessionId: any, session: any, snapshot: any, limit: any, browserId: any) =>
        host.coldSessionViewFromSnapshot(sessionId, session, snapshot, limit, browserId),
      projectMessages: (sessionId: any, session: any, limit: any, browserId: any) =>
        host.coldSessionView(sessionId, session, limit, browserId),
      forkOrigin: (sessionId: any) => host.forkOriginForSession(sessionId),
    }, id, turnLimit, clientId, includeForkOrigin);
  }

  async function sessionView(
    id: string,
    turnLimit = RECENT_TURN_WINDOW_SIZE,
    clientId = "",
    options: { fast?: boolean; includeForkOrigin?: boolean } = {},
  ): Promise<SessionViewData | null> {
    return readSessionView({
      isPrimary: (sessionId: any) => sessionId === host.activeSessionId,
      secondaryExists: (sessionId: any) => host.runtimePool.has(sessionId),
      acquirePrimary: () => {
        const lease = host.primaryOperationAdmission.acquire();
        return { ...lease, rpcGeneration: host.options.rpc.currentGeneration?.() || 0 };
      },
      primaryCurrent: (sessionId: any, lease: any) =>
        host.activeSessionId === sessionId
        && host.primaryOperationAdmission.generation === lease.generation
        && (host.options.rpc.currentGeneration?.() || 0) === lease.rpcGeneration
        && host.options.rpc.isRunning?.() !== false,
      acquireSecondary: (sessionId: any) => {
        const runtime = host.runtimePool.get(sessionId)!;
        const release = host.runtimePool.acquireOperation(runtime);
        return {
          generation: runtime.operationAdmission.generation,
          rpcGeneration: runtime.rpc.currentGeneration?.() || 0,
          release,
        };
      },
      secondaryCurrent: (sessionId: any, lease: any) => {
        const runtime = host.runtimePool.get(sessionId);
        return Boolean(
          runtime
          && runtime.operationAdmission.generation === lease.generation
          && (runtime.rpc.currentGeneration?.() || 0) === lease.rpcGeneration
          && runtime.rpc.isRunning?.() !== false,
        );
      },
      hotView: (sessionId: any, limit: any, browserId: any) => host.hotMemoryView(sessionId, limit, browserId),
      currentProjection: (sessionId: any, limit: any, browserId: any, assertCurrent: any) =>
        host.sessionViewFromCurrentProjection(sessionId, limit, browserId, assertCurrent),
      coldView: (sessionId: any, limit: any, browserId: any, includeForkOrigin: any) =>
        host.coldSessionViewForId(sessionId, limit, browserId, includeForkOrigin),
      forkOrigin: (sessionId: any) => host.forkOriginForSession(sessionId),
    }, id, turnLimit, clientId, options);
  }

  async function sessionViewFromCurrentProjectionAction(
    id: string,
    turnLimit = RECENT_TURN_WINDOW_SIZE,
    clientId = "",
    assertCurrentHotRuntime?: () => void,
  ): Promise<SessionViewData | null> {
    const owner = host;
    return sessionViewFromCurrentProjectionService({
      index: host.options.sessions,
      primaryRpc: host.options.rpc,
      builtinCommands: BUILTIN_COMMANDS,
      secondaryForId: (sessionId: any) => host.runtimePool.get(sessionId),
      touchSecondary: (runtime: any) => host.runtimePool.touch(runtime),
      get activeSessionId() { return owner.activeSessionId; },
      get activeSessionPath() { return owner.activeSessionPath; },
      get applicationLifecycle() { return owner.applicationLifecycle; },
      get currentCwd() { return owner.currentCwd; },
      get primaryRpcGeneration() { return owner.primaryRpcGeneration; },
      get lastPrimaryState() { return owner.lastPrimaryState; },
      set lastPrimaryState(state) { owner.lastPrimaryState = state; },
      get running() { return owner.running; },
      set running(running) { owner.running = running; },
      get primarySummarySnapshot() { return owner.primarySummarySnapshot; },
      set primarySummarySnapshot(summary) { owner.primarySummarySnapshot = summary; },
      get liveMessage() { return owner.liveMessage; },
      get toolStatus() { return owner.toolStatus; },
      get lastPrimaryMessagesSessionId() { return owner.lastPrimaryMessagesSessionId; },
      set lastPrimaryMessagesSessionId(id) { owner.lastPrimaryMessagesSessionId = id; },
      get lastPrimaryMessages() { return owner.lastPrimaryMessages; },
      set lastPrimaryMessages(messages) { owner.lastPrimaryMessages = messages; },
      get primaryPendingTerminalSessionId() { return owner.primaryPendingTerminalSessionId; },
      get primaryPendingTerminalMessages() { return owner.primaryPendingTerminalMessages; },
      set primaryPendingTerminalMessages(messages) { owner.primaryPendingTerminalMessages = messages; },
      get lastPrimaryCommands() { return owner.lastPrimaryCommands; },
      get primaryGateMode() { return owner.primaryGateMode; },
      get queuePaused() { return owner.queuePaused; },
      now: () => host.now(),
      primaryTurnActive: () => host.primaryTurnActive(),
      runtimeTurnActive: (runtime: any) => host.runtimeTurnActive(runtime),
      primaryReadReady: () => host.primaryReadReady(),
      bindPrimaryIdentity: (state: any) => host.bindPrimaryIdentity(state),
      coldSessionViewForId: (id: any, limit: any, client: any) => host.coldSessionViewForId(id, limit, client),
      coldSessionView: (id: any, session: any, limit: any, client: any) => host.coldSessionView(id, session, limit, client),
      sessionSummaries: (sessions: any, client: any) => host.sessionSummaries(sessions, client),
      reconcilePendingAcceptedPrompts: (id: any, messages: any) => host.reconcilePendingAcceptedPrompts(id, messages),
      pendingPromptForSession: (id: any) => host.pendingPromptForSession(id),
      pendingSteerProjection: (id: any) => host.pendingSteerProjection(id),
      statsForSession: (id: any, response: any) => host.statsForSession(id, response),
      offlineStatsForId: (id: any, usage: any) => host.offlineStatsForId(id, usage),
      stateWithFastMode: (id: any, state: any) => host.stateWithFastMode(id, state),
      stateWithPendingPromptSettings: (id: any, state: any) => host.stateWithPendingPromptSettings(id, state),
      sessionActivity: (id: any) => host.sessionActivity(id),
      controlState: (id: any, client: any) => host.controlState(id, client),
      publicQueue: (queue: any) => host.publicQueue(queue),
      pendingRequestForSession: (id: any) => host.pendingRequestForSession(id),
    }, id, turnLimit, clientId, assertCurrentHotRuntime);
  }

  /**
   * Token stats for a cold session, derived from its JSONL instead of waking
   * a Pi process. The context window comes from the model catalogue; when the
   * model is unknown the percentage stays unavailable rather than guessed.
   */
  function markContextUsagePendingRefresh(id: string): void {
    if (id) host.contextUsagePendingRefresh.add(id);
  }

  function beginContextUsageRefreshTurn(id: string): void {
    if (host.contextUsagePendingRefresh.has(id))
      host.contextUsageRefreshTurn.add(id);
  }

  function completeContextUsageRefreshTurn(id: string): void {
    if (!host.contextUsageRefreshTurn.delete(id)) return;
    host.contextUsagePendingRefresh.delete(id);
  }

  function rememberModelContextWindows(models: ModelInfo[]): void {
    for (const model of models) {
      const key = `${model.provider}\u0000${model.id}`;
      host.knownModels.set(key, model);
      if (typeof model.contextWindow === "number" && model.contextWindow > 0)
        host.modelContextWindows.set(key, model.contextWindow);
    }
  }

  function modelFromSessionSettings(
    settings: SessionSettingsSnapshot,
  ): ModelInfo | null {
    if (!settings.provider || !settings.modelId) return null;
    return (
      host.knownModels.get(`${settings.provider}\u0000${settings.modelId}`) ||
        // Keep the actual persisted identifier visible if a model was later removed
        // from the current catalogue; this is still more truthful than Primary's model.
        {
          provider: settings.provider,
          id: settings.modelId,
          name: settings.modelId,
        }
    );
  }

  function offlineStatsFromUsage(
    id: string,
    usage: SessionUsageSnapshot,
  ): SessionStats {
    const stats: SessionStats = { tokens: usage.tokens };
    if (usage.context) {
      const contextWindow =
        host.modelContextWindows.get(
          `${usage.context.provider || ""}\u0000${usage.context.model || ""}`,
        ) || 0;
      if (!contextWindow)
        console.warn(
          `[Pi Chat] 冷会话上下文用量：未找到模型 ${usage.context.provider}/${usage.context.model} 的 contextWindow`,
        );
      if (contextWindow > 0) {
        const pendingRefresh = host.contextUsagePendingRefresh.has(id);
        stats.contextUsage = pendingRefresh
          ? { tokens: null, contextWindow, percent: null }
          : {
              tokens: usage.context.tokens,
              contextWindow,
              percent: Math.min(
                100,
                (usage.context.tokens / contextWindow) * 100,
              ),
            };
        if (pendingRefresh) stats.contextUsagePendingRefresh = true;
      }
    }
    return stats;
  }

  async function offlineStatsForId(
    id: string,
    knownUsage?: SessionUsageSnapshot,
  ): Promise<SessionStats | undefined> {
    // Optional-chained: test doubles and older indexes may not implement usageForId.
    const usage =
      knownUsage ??
      (await Promise.resolve(host.options.sessions.usageForId?.(id)).catch(
        () => null,
      ));
    return usage ? host.offlineStatsFromUsage(id, usage) : undefined;
  }

  /** Prefer Pi's live counters, but use persisted usage whenever it omits occupancy. */
  async function statsForSession(
    id: string,
    response: Record<string, unknown>,
    knownUsage?: SessionUsageSnapshot,
  ): Promise<SessionStats> {
    const live = asSessionStats(response);
    const fallback = await host.offlineStatsForId(id, knownUsage);
    const contextUsage = live.contextUsage || fallback?.contextUsage;
    return {
      ...live,
      ...(contextUsage ? { contextUsage } : {}),
      ...(fallback?.contextUsagePendingRefresh
        ? { contextUsagePendingRefresh: true }
        : {}),
    };
  }


  return {
    coldSessionView,
    coldSessionViewFromSnapshot,
    hotMemoryView,
    coldSessionViewForId,
    sessionView,
    sessionViewFromCurrentProjection: sessionViewFromCurrentProjectionAction,
    markContextUsagePendingRefresh,
    beginContextUsageRefreshTurn,
    completeContextUsageRefreshTurn,
    rememberModelContextWindows,
    modelFromSessionSettings,
    offlineStatsFromUsage,
    offlineStatsForId,
    statsForSession,
  };
}
