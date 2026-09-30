import { reconcilePersistedHistory } from "../../shared/streaming-assistant.js";
import type { BootstrapData, ModelInfo, PiMessage, PiState, SessionStats, SessionSummary, SlashCommand } from "../../shared/types.js";
import { ApplicationLifecycleConflictError } from "../application-lifecycle.js";
import { asCommands, asMessages, asModels, asSessionStats, asState, messageWindow, RECENT_TURN_WINDOW_SIZE } from "../pi-data.js";
import { readSessionSnapshot, SessionIndex } from "../session-index.js";
import { StaleSessionViewRuntimeError } from "./session-view-service.js";

export async function bootstrap(ports: any, clientId = "", coherenceRetry = 0): Promise<BootstrapData> {
    const readinessAtStart = ports.primaryReadiness();
    if (
      ports.applicationLifecycle !== "idle" &&
      (ports.primaryFailed || ports.options.rpc.isRunning?.() === false)
    ) {
      throw new ApplicationLifecycleConflictError(
        ports.applicationLifecycle,
        ports.lifecycleMessage(),
      );
    }
    // Bootstrap is a Session directory/read projection, not permission to make
    // the service wait for a stopped Primary. A healthy existing worker still
    // provides its current state, while a missing/crashed worker is recovered
    // only at the first real write (or an explicit activation).
    const primaryAvailable =
      readinessAtStart.status === "ready" &&
      !ports.primaryFailed &&
      ports.options.rpc.isRunning?.() !== false;
    const primaryStateAdopted = Boolean(
      ports.primaryBoundSessionId &&
        ports.primaryRpcGeneration &&
        ports.primaryRpcGeneration ===
          (ports.options.rpc.currentGeneration?.() || ports.primaryRpcGeneration),
    );
    let state = ports.lastPrimaryState;
    // An empty list is meaningful only after this generation has completed its
    // read-only discovery. While Primary is starting/busy, retain any cached
    // catalogue on the browser and keep the UI explicitly pending.
    let modelInventoryPending = true;
    let currentBootstrapStats: SessionStats | undefined;
    if (
      primaryAvailable &&
      !primaryStateAdopted &&
      !(ports.primaryTurnActive() && ports.activeSessionPath)
    ) {
      try {
        state = asState(
          await ports.options.rpc.send(
            { type: "get_state" },
            ports.activeSessionPath ? 4_000 : 12_000,
          ),
        );
        ports.lastPrimaryState = state;
        ports.running = state.isStreaming;
        ports.bindPrimaryIdentity(state);
      } catch (error) {
        if (!ports.activeSessionPath) throw error;
        state = {
          ...ports.lastPrimaryState,
          isStreaming: ports.primaryTurnActive(),
        };
      }
    } else if (ports.primaryTurnActive() && ports.activeSessionPath)
      state = { ...state, isStreaming: true };

    const busy = ports.primaryTurnActive() || state.isStreaming;
    if (busy && !state.isStreaming) state = { ...state, isStreaming: true };
    if (!ports.lastAvailableModels.length && state.model) {
      ports.rememberModelContextWindows([state.model]);
      ports.lastAvailableModels = [state.model];
    }
    // During a cold start the controller may have bound the authoritative
    // Session state before app.activeSessionPath is copied. The state response
    // carries the same verified JSONL path; use it to avoid returning an empty
    // transcript for an already-existing Session.
    const activeSessionPath = ports.activeSessionPath || state.sessionFile;
    const diskSnapshot = activeSessionPath
      ? await readSessionSnapshot(activeSessionPath).catch(() => null)
      : null;
    const diskMessages = diskSnapshot?.messages ?? null;
    let messages: PiMessage[] | null = null;
    const primaryTerminalTail =
      ports.primaryPendingTerminalSessionId === ports.activeSessionId
        ? ports.primaryPendingTerminalMessages
        : [];
    if (diskMessages) {
      const reconciled = reconcilePersistedHistory(
        diskMessages,
        primaryTerminalTail,
      );
      ports.lastPrimaryMessages = diskMessages;
      ports.primaryPendingTerminalMessages = reconciled.pending;
      ports.lastPrimaryMessagesSessionId = ports.activeSessionId;
      messages = reconciled.messages;
    } else if (ports.lastPrimaryMessagesSessionId === ports.activeSessionId) {
      messages = reconcilePersistedHistory(
        ports.lastPrimaryMessages,
        primaryTerminalTail,
      ).messages;
    }
    // JSONL is authoritative enough for an immediately readable bootstrap.
    // An empty brand-new busy Session can render its live/optimistic message;
    // never hold the whole shell open waiting for get_messages.
    if (primaryAvailable && !messages && !busy) {
      const rpcMessages = asMessages(
        await ports.options.rpc.send({ type: "get_messages" }, 12_000),
      );
      const reconciled = reconcilePersistedHistory(
        rpcMessages,
        primaryTerminalTail,
      );
      ports.lastPrimaryMessages = rpcMessages;
      ports.primaryPendingTerminalMessages = reconciled.pending;
      ports.lastPrimaryMessagesSessionId = ports.activeSessionId;
      messages = reconciled.messages;
    }

    if (primaryAvailable && !busy) {
      const [modelsResponse, commandsResponse, statsResponse] =
        await Promise.all([
          ports.options.rpc
            .send({ type: "get_available_models" }, 8_000)
            .catch(() => null),
          ports.options.rpc
            .send({ type: "get_commands" }, 8_000)
            .catch(() => null),
          ports.options.rpc
            .send({ type: "get_session_stats" }, 8_000)
            .catch(() => null),
        ]);
      if (modelsResponse) {
        const models = ports.options.modelManager
          ? await ports.options.modelManager.annotate(asModels(modelsResponse))
          : asModels(modelsResponse);
        ports.rememberModelContextWindows(models);
        ports.lastAvailableModels = models;
        // Preserve the legacy wildcard only for Host rows that truly omit API.
        // Once a row declares an API route, the Runtime must confirm the same
        // provider + model + api identity before clearing pending sync.
        if (ports.startupModels.every((configured: ModelInfo) =>
          models.some((loaded: ModelInfo) => ports.modelRouteKey(loaded) === ports.modelRouteKey(configured)
            || (!configured.api
              && loaded.provider === configured.provider
              && loaded.id === configured.id))))
          ports.modelRuntimeSyncPending = false;
        modelInventoryPending = false;
      }
      if (commandsResponse)
        ports.lastPrimaryCommands = asCommands(commandsResponse);
      if (statsResponse) {
        currentBootstrapStats = await ports.statsForSession(
          ports.activeSessionId,
          statsResponse,
          diskSnapshot?.usage,
        );
        ports.lastPrimaryStats = {
          sessionId: ports.activeSessionId,
          value: currentBootstrapStats,
        };
      }
    }
    const availableModels = ports.mergeHostAndRuntimeModels(
      ports.lastAvailableModels.length ? ports.lastAvailableModels : [],
      ports.startupModels,
    );
    ports.reconcilePendingAcceptedPrompts(
      ports.activeSessionId,
      messages || [],
    );
    const pendingPrompt = ports.pendingPromptForSession(ports.activeSessionId);
    const pendingSteerProjection = ports.pendingSteerProjection(ports.activeSessionId);
    const windowedMessages = messageWindow(messages || []);
    // Bootstrap is the browser's recovery boundary. It must revalidate the
    // physical Session inventory instead of returning the short-lived cached
    // list: another window/process may have removed a JSONL since the cache was
    // populated, and a stale row would otherwise survive reload/reconnect.
    const sidebar = ports.sidebarSessions(
      await ports.options.sessions.list(activeSessionPath),
      clientId,
    );
    ports.primarySummarySnapshot =
      sidebar.sessions.find((session: SessionSummary) => session.id === ports.activeSessionId) ||
      ports.primarySummarySnapshot;
    const readinessAtEnd = ports.primaryReadiness();
    if (
      coherenceRetry < 1 &&
      (readinessAtEnd.generation !== readinessAtStart.generation ||
        readinessAtEnd.status !== readinessAtStart.status)
    ) {
      // Startup/recovery crossed this request while independent Session/JSONL
      // work was awaiting. Never return old state with a newer ready marker (or
      // the reverse); rebuild once from the already-adopted generation. This
      // does not send another get_state for a controller-owned Primary.
      return ports.bootstrap(clientId, coherenceRetry + 1);
    }
    const forkOrigin = ports.activeSessionId
      ? await ports.forkOriginForSession(ports.activeSessionId)
      : undefined;
    return {
      buildIdentity: ports.buildIdentity,
      ...(ports.options.piVersion ? { piVersion: ports.options.piVersion } : null),
      ...(forkOrigin ? { forkOrigin } : null),
      state: ports.stateWithFastMode(
        ports.activeSessionId,
        ports.stateWithPendingPromptSettings(ports.activeSessionId, state),
      ),
      ...(pendingPrompt ? { pendingPrompt } : null),
      pendingSteers: pendingSteerProjection.items,
      pendingSteerRevision: pendingSteerProjection.revision,
      messages: windowedMessages.messages,
      messageTotal: windowedMessages.total,
      turnTotal: windowedMessages.turns,
      visibleTurnCount: windowedMessages.visibleTurns,
      messagesTruncated: windowedMessages.truncated,
      activeSessionId: ports.activeSessionId,
      activeSessionIds: ports.activeSessionIds(),
      liveMessage: ports.liveMessage,
      toolStatus: ports.toolStatus,
      stats: currentBootstrapStats
        ?? (diskSnapshot?.usage
          ? ports.offlineStatsFromUsage(ports.activeSessionId, diskSnapshot.usage)
          : ports.lastPrimaryStats?.sessionId === ports.activeSessionId
            ? ports.lastPrimaryStats.value
            : await ports.offlineStatsForId(ports.activeSessionId)),
      models: availableModels,
      modelInventoryPending,
      modelCatalogueRevision: ports.modelCatalogueRevision,
      modelRuntimeSyncPending: ports.modelRuntimeSyncPending,
      commands: [...ports.builtinCommands, ...ports.lastPrimaryCommands],
      queue: ports.publicQueue(),
      queuePaused: ports.queuePaused,
      pendingExtensionRequest: ports.pendingRequestForSession(
        ports.activeSessionId,
      ),
      gateMode: ports.primaryGateMode,
      ...ports.controlState(ports.activeSessionId, clientId),
      workspaceCwd: ports.currentCwd,
      workspaceEpoch: ports.runEpoch,
      workspaceRevision: ports.workspaceRevision,
      sessions: sidebar.sessions,
      sessionDirectories: sidebar.directories,
      sessionsTotal: sidebar.total,
      applicationLifecycle: ports.applicationLifecycle,
      primaryRuntime: readinessAtStart,
    };
  }
