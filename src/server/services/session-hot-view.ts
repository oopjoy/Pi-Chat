import { assistantMessageRequestsTool, reconcilePersistedHistory } from "../../shared/streaming-assistant.js";
import type { ApplicationLifecycle, ExtensionUiRequest, GateMode, PendingPromptProjection, PendingSteer, PiMessage, PiState, QueuedPrompt, SessionActivityState, SessionStats, SessionViewData, SessionSummary, SlashCommand } from "../../shared/types.js";
import { asCommands, asMessages, asState, messageWindow, RECENT_TURN_WINDOW_SIZE } from "../pi-data.js";
import { readSessionMessages, type SessionIndex, type SessionFileSnapshot, type SessionUsageSnapshot } from "../session-index.js";
import type { SecondaryRuntime, RuntimeQueuedPrompt } from "../runtime-pool.js";
import type { PiRpcClient } from "../rpc-client.js";
import { StaleSessionViewRuntimeError } from "./session-view-service.js";

export interface SessionHotViewPorts {
  index: SessionIndex;
  primaryRpc: PiRpcClient;
  builtinCommands: SlashCommand[];
  secondaryForId(id: string): SecondaryRuntime | undefined;
  touchSecondary(runtime: SecondaryRuntime): void;
  readonly activeSessionId: string;
  readonly activeSessionPath?: string;
  readonly applicationLifecycle: ApplicationLifecycle;
  readonly currentCwd: string;
  readonly primaryRpcGeneration: number;
  lastPrimaryState: PiState;
  running: boolean;
  primarySummarySnapshot?: SessionSummary;
  readonly liveMessage?: PiMessage;
  readonly toolStatus: string;
  lastPrimaryMessages: PiMessage[];
  lastPrimaryMessagesSessionId: string;
  readonly primaryPendingTerminalSessionId: string;
  primaryPendingTerminalMessages: PiMessage[];
  readonly lastPrimaryCommands: SlashCommand[];
  readonly primaryGateMode: GateMode;
  readonly queuePaused: boolean;
  now(): number;
  primaryTurnActive(): boolean;
  runtimeTurnActive(runtime: SecondaryRuntime): boolean;
  primaryReadReady(): boolean;
  bindPrimaryIdentity(state: PiState): void;
  coldSessionViewForId(id: string, turns: number, client: string): Promise<SessionViewData | null>;
  coldSessionView(id: string, session: SessionSummary, turns: number, client: string): Promise<SessionViewData | null>;
  sessionSummaries(sessions: SessionSummary[], client: string): SessionSummary[];
  reconcilePendingAcceptedPrompts(id: string, messages: PiMessage[]): void;
  pendingPromptForSession(id: string): PendingPromptProjection | undefined;
  pendingSteerProjection(id: string): { items: PendingSteer[]; revision: number };
  statsForSession(id: string, response: Record<string, unknown>): Promise<SessionStats>;
  offlineStatsForId(id: string, usage?: SessionUsageSnapshot): Promise<SessionStats | undefined>;
  stateWithFastMode(id: string, state: PiState): PiState;
  stateWithPendingPromptSettings(id: string, state: PiState): PiState;
  sessionActivity(id: string): SessionActivityState;
  controlState(id: string, client: string): { controlOwner?: string; controlledByThisWindow?: boolean };
  publicQueue(queue?: RuntimeQueuedPrompt[]): QueuedPrompt[];
  pendingRequestForSession(id: string): ExtensionUiRequest | undefined;
}

/** Target-only read transaction. State accessors forward to the existing Runtime owner. */
export async function sessionViewFromCurrentProjection(
  ports: SessionHotViewPorts,
  id: string,
    turnLimit = RECENT_TURN_WINDOW_SIZE,
    clientId = "",
    assertCurrentHotRuntime?: () => void,
): Promise<SessionViewData | null> {
    const knownRuntime = ports.secondaryForId(id);
    const targetRuntimeBusy =
      id === ports.activeSessionId
        ? ports.primaryTurnActive()
        : Boolean(
            knownRuntime &&
            (ports.runtimeTurnActive(knownRuntime) || knownRuntime.dispatching),
          );
    // Cold history is a pure JSONL read. Avoid waking or querying the Primary RPC
    // and avoid rescanning every Session when the index already knows this ID.
    if (id !== ports.activeSessionId && !knownRuntime) {
      // A target-only snapshot read already validates and parses the JSONL. Use
      // its summary projection too, avoiding a second stat/fingerprint/outline
      // pass during a cold navigation. Large files take the bounded tail path.
      const cold = await ports.coldSessionViewForId(id, turnLimit, clientId);
      if (cold) return cold;
    }
    // Browser /api/sessions/:id/view has a 65s client budget. Several default 30s
    // Pi RPC calls used to stack past that during compaction or long tool turns,
    // producing a late red "请求超时（65 秒）" even after compaction finished.
    const SHORT_RPC_MS = 4_000;
    const MESSAGES_RPC_MS = 6_000;
    const primaryAvailable =
      ports.applicationLifecycle === "idle" && ports.primaryReadReady();
    let state: PiState = ports.lastPrimaryState;
    if (
      primaryAvailable &&
      !(id !== ports.activeSessionId && targetRuntimeBusy)
    ) {
      // Controller-managed startup already adopted the exact state response
      // that certified this child. A view must never reopen authority binding
      // with another get_state; retain a legacy fallback only when no adopted
      // generation exists.
      const currentPrimaryGeneration =
        ports.primaryRpc.currentGeneration?.() || 0;
      const canSkipStateProbe =
        Boolean(ports.activeSessionId) &&
        Boolean(ports.activeSessionPath) &&
        (currentPrimaryGeneration
          ? ports.primaryRpcGeneration === currentPrimaryGeneration
          : ports.primaryTurnActive());
      if (canSkipStateProbe) {
        state = {
          ...ports.lastPrimaryState,
          isStreaming: targetRuntimeBusy,
        };
      } else {
        try {
          state = asState(
            await ports.primaryRpc.send({ type: "get_state" }, SHORT_RPC_MS),
          );
          assertCurrentHotRuntime?.();
          ports.lastPrimaryState = state;
          ports.running = state.isStreaming;
          ports.bindPrimaryIdentity(state);
        } catch (error) {
          if (error instanceof StaleSessionViewRuntimeError) throw error;
          state = ports.running
            ? { ...ports.lastPrimaryState, isStreaming: true }
            : ports.lastPrimaryState;
        }
      }
    } else {
      state = { model: null, isStreaming: false };
    }
    const secondaryRuntime = knownRuntime;
    const knownBusy =
      id === ports.activeSessionId
        ? ports.primaryTurnActive()
        : Boolean(
            secondaryRuntime &&
            (ports.runtimeTurnActive(secondaryRuntime) ||
              secondaryRuntime.dispatching),
          );
    // An already-open Runtime has stable target identity in memory or in the
    // persisted metadata cache. Opening its idle view must not wait behind a
    // global JSONL inventory refresh.
    const index = ports.index as SessionIndex & {
      cachedSummaryForId?: (
        sessionId: string,
      ) => Promise<SessionSummary | null>;
    };
    const knownHotRuntime =
      id === ports.activeSessionId || Boolean(secondaryRuntime);
    let indexedSession = knownHotRuntime
      ? ports.index.summaryForId?.(id) ||
        (id === ports.activeSessionId && ports.primarySummarySnapshot?.id === id
          ? ports.primarySummarySnapshot
          : null) ||
        secondaryRuntime?.summarySnapshot ||
        secondaryRuntime?.draftSession ||
        null
      : null;
    if (!indexedSession && knownHotRuntime)
      indexedSession = await index.cachedSummaryForId?.(id) || null;
    assertCurrentHotRuntime?.();
    if (!indexedSession && id === ports.activeSessionId) {
      indexedSession = {
        id,
        sessionId: state.sessionId || id,
        name: state.sessionName || "当前对话",
        preview: state.sessionName || "当前对话",
        cwd: ports.currentCwd,
        updatedAt: ports.now(),
        messageCount: state.messageCount || 0,
        active: true,
      };
    }
    const sessions = indexedSession
      ? ports.sessionSummaries([{ ...indexedSession, active: true }], clientId)
      : ports.sessionSummaries(
          await ports.index.list(
            ports.activeSessionPath,
            ports.currentCwd,
          ),
          clientId,
        );
    assertCurrentHotRuntime?.();
    // A fresh New view is valid even though it is deliberately absent from the
    // sidebar until its first user message is persisted.
    const session =
      sessions.find((item: SessionSummary) => item.id === id) || secondaryRuntime?.draftSession;
    if (!session) return null;
    const secondaryReadable =
      ports.applicationLifecycle === "idle" &&
      secondaryRuntime &&
      !secondaryRuntime.failed &&
      secondaryRuntime.rpc.isRunning?.() !== false
        ? secondaryRuntime
        : null;
    const runtime =
      id === ports.activeSessionId && primaryAvailable
        ? {
            rpc: ports.primaryRpc,
            running: ports.running,
            liveMessage: ports.liveMessage,
            toolStatus: ports.toolStatus,
          }
        : secondaryReadable;
    if (runtime) {
      if (id !== ports.activeSessionId)
        ports.touchSecondary(runtime as SecondaryRuntime);
      const busy =
        runtime.running ||
        Boolean(runtime.liveMessage) ||
        Boolean(runtime.toolStatus) ||
        Boolean((runtime as SecondaryRuntime).dispatching);
      const sessionIndex = ports.index as SessionIndex & {
        cachedSnapshotForId?: (
          sessionId: string,
        ) => SessionFileSnapshot | null;
        snapshotForId?: (
          sessionId: string,
        ) => Promise<SessionFileSnapshot | null>;
      };
      // For an already-open streaming Session, use the last parsed JSONL branch
      // immediately. The live assistant snapshot arrives separately over SSE.
      let snapshot = busy
        ? (sessionIndex.cachedSnapshotForId?.(id) ?? null)
        : null;
      if (!snapshot && !busy && sessionIndex.snapshotForId)
        snapshot = await sessionIndex.snapshotForId(id);
      assertCurrentHotRuntime?.();
      const persistedRuntimeMessages =
        id === ports.activeSessionId && ports.lastPrimaryMessagesSessionId === id
          ? ports.lastPrimaryMessages
          : (secondaryRuntime?.messageSnapshot ?? null);
      const terminalTail =
        id === ports.activeSessionId
          ? ports.primaryPendingTerminalSessionId === id
            ? ports.primaryPendingTerminalMessages
            : []
          : secondaryRuntime?.pendingTerminalMessages || [];
      let persistedMessages: PiMessage[] | null =
        snapshot?.messages ??
        (busy
          ? persistedRuntimeMessages
          : typeof ports.index.messagesForId === "function"
            ? await ports.index.messagesForId(id)
            : null);
      assertCurrentHotRuntime?.();
      let messages: PiMessage[] | null = persistedMessages
        ? reconcilePersistedHistory(persistedMessages, terminalTail).messages
        : terminalTail.length
          ? reconcilePersistedHistory([], terminalTail).messages
          : null;
      if (!messages && !busy) {
        const path =
          (typeof ports.index.pathForId === "function"
            ? ports.index.pathForId(id)
            : null) ||
          (runtime as SecondaryRuntime).sessionPath ||
          (runtime as SecondaryRuntime).draftSessionPath;
        if (path) {
          try {
            persistedMessages = await readSessionMessages(path);
            assertCurrentHotRuntime?.();
            messages = reconcilePersistedHistory(
              persistedMessages,
              terminalTail,
            ).messages;
          } catch (error) {
            if (error instanceof StaleSessionViewRuntimeError) throw error;
            messages = null;
          }
        }
      }
      let stateResponse: Record<string, unknown> | null = null;
      let statsResponse: Record<string, unknown> | null = null;
      let commandsResponse: Record<string, unknown> | null = null;
      const terminalCandidate = terminalTail.at(-1);
      const terminalIdleProbe = Boolean(
        busy &&
          !runtime.liveMessage &&
          terminalCandidate?.role === "assistant" &&
          !assistantMessageRequestsTool(terminalCandidate),
      );
      if (!busy || terminalIdleProbe) {
        try {
          const primaryAdopted =
            id === ports.activeSessionId &&
            Boolean(ports.primaryRpcGeneration) &&
            ports.primaryRpcGeneration ===
              (ports.primaryRpc.currentGeneration?.() || 0);
          const probes = await Promise.all([
            primaryAdopted && !terminalIdleProbe
              ? Promise.resolve(null)
              : runtime.rpc
                  .send({ type: "get_state" }, SHORT_RPC_MS)
                  .catch(() => null),
            terminalIdleProbe
              ? Promise.resolve(null)
              : runtime.rpc
                  .send({ type: "get_session_stats" }, SHORT_RPC_MS)
                  .catch(() => null),
            terminalIdleProbe
              ? Promise.resolve(null)
              : runtime.rpc
                  .send({ type: "get_commands" }, SHORT_RPC_MS)
                  .catch(() => null),
          ]);
          assertCurrentHotRuntime?.();
          stateResponse = probes[0];
          statsResponse = probes[1];
          commandsResponse = probes[2];
        } catch (error) {
          if (error instanceof StaleSessionViewRuntimeError) throw error;
          // Disk history + last known liveMessage still form a usable view.
        }
      }
      const rememberedState =
        id === ports.activeSessionId
          ? ports.lastPrimaryState
          : secondaryRuntime?.lastState || { model: null };
      const liveState = stateResponse
        ? asState(stateResponse)
        : ({
            ...rememberedState,
            isStreaming: busy,
          } satisfies PiState);
      const terminalProbeConfirmedIdle = Boolean(
        terminalIdleProbe && stateResponse && !liveState.isStreaming,
      );
      if (stateResponse && id === ports.activeSessionId) {
        ports.lastPrimaryState = liveState;
        // A missing agent_settled frame must not let a read route release the
        // server's FIFO run authority. The browser may present the confirmed
        // idle state, while the owner still queues writes until Pi's lifecycle
        // frame (or recovery) closes the generation.
        if (!terminalIdleProbe) ports.running = liveState.isStreaming;
      } else if (stateResponse && secondaryRuntime) {
        secondaryRuntime.lastState = liveState;
        if (!terminalIdleProbe) secondaryRuntime.running = liveState.isStreaming;
      }
      if (secondaryRuntime && commandsResponse) {
        secondaryRuntime.commands = asCommands(commandsResponse);
        secondaryRuntime.commandsKnown = true;
      }
      // Only hit get_messages when disk is empty. Never wait on a busy worker
      // when terminal SSE rows or a persisted snapshot already form a view.
      if (!messages && busy) messages = [];
      if (!messages) {
        try {
          persistedMessages = asMessages(
            await runtime.rpc.send(
              { type: "get_messages" },
              busy ? 3_000 : MESSAGES_RPC_MS,
            ),
          );
          assertCurrentHotRuntime?.();
          messages = reconcilePersistedHistory(
            persistedMessages,
            terminalTail,
          ).messages;
        } catch (error) {
          throw error;
        }
      }
      if (!messages) throw new Error("无法读取会话消息");
      ports.reconcilePendingAcceptedPrompts(id, persistedMessages || messages);
      if (persistedMessages) {
        const reconciled = reconcilePersistedHistory(
          persistedMessages,
          terminalTail,
        );
        if (id === ports.activeSessionId) {
          ports.lastPrimaryMessages = persistedMessages;
          ports.lastPrimaryMessagesSessionId = id;
          // Keep the final terminal as bounded repair evidence while the server
          // still awaits lifecycle settlement. Otherwise one transient state
          // probe can reconcile it out of the tail and make every later view
          // revive the stale Stop button permanently.
          ports.primaryPendingTerminalMessages = terminalIdleProbe
            ? terminalTail
            : reconciled.pending;
        } else if (secondaryRuntime) {
          secondaryRuntime.messageSnapshot = persistedMessages;
          secondaryRuntime.pendingTerminalMessages = terminalIdleProbe
            ? terminalTail
            : reconciled.pending;
        }
        messages = reconciled.messages;
      }
      const pendingPrompt = ports.pendingPromptForSession(id);
      const pendingSteerProjection = ports.pendingSteerProjection(id);
      const windowed = messageWindow(messages, turnLimit);
      const stats = statsResponse
        ? await ports.statsForSession(id, statsResponse)
        : busy
          ? snapshot
            ? await ports.offlineStatsForId(id, snapshot.usage)
            : undefined
          : await ports.offlineStatsForId(id, snapshot?.usage);
      assertCurrentHotRuntime?.();
      const rememberedCommands =
        id === ports.activeSessionId
          ? ports.lastPrimaryCommands
          : secondaryRuntime?.commands;
      if (secondaryRuntime) {
        secondaryRuntime.summarySnapshot = session;
        secondaryRuntime.lastStats = stats;
        secondaryRuntime.statsKnown =
          Boolean(statsResponse) || secondaryRuntime.statsKnown;
      } else if (id === ports.activeSessionId)
        ports.primarySummarySnapshot = session;
      const presentationBusy = terminalProbeConfirmedIdle ? false : busy;
      const visibleQueue =
        id === ports.activeSessionId
          ? ports.publicQueue()
          : ports.publicQueue((runtime as SecondaryRuntime).promptQueue);
      const visibleQueuePaused = visibleQueue.length > 0 && (
        id === ports.activeSessionId
          ? ports.queuePaused
          : (runtime as SecondaryRuntime).queuePaused
      );
      return {
        session: {
          ...session,
          running: presentationBusy,
          activity: ports.sessionActivity(id),
        },
        state: ports.stateWithFastMode(id, {
          ...ports.stateWithPendingPromptSettings(id, liveState),
          isStreaming: presentationBusy || liveState.isStreaming,
        }),
        messages: windowed.messages,
        messageTotal: windowed.total,
        turnTotal: windowed.turns,
        visibleTurnCount: windowed.visibleTurns,
        messagesTruncated: windowed.truncated,
        isActive: true,
        runtimeStatus: "active",
        isStreaming: presentationBusy || liveState.isStreaming,
        liveMessage: terminalProbeConfirmedIdle ? undefined : runtime.liveMessage,
        toolStatus: terminalProbeConfirmedIdle ? "" : runtime.toolStatus,
        stats,
        queue: visibleQueue,
        queuePaused: visibleQueuePaused,
        commands: commandsResponse
          ? [...ports.builtinCommands, ...asCommands(commandsResponse)]
          : rememberedCommands?.length
            ? [...ports.builtinCommands, ...rememberedCommands]
            : undefined,
        gateMode:
          id === ports.activeSessionId
            ? ports.primaryGateMode
            : (runtime as SecondaryRuntime).gateMode,
        pendingExtensionRequest: ports.pendingRequestForSession(id),
        ...(pendingPrompt ? { pendingPrompt } : null),
        pendingSteers: pendingSteerProjection.items,
        pendingSteerRevision: pendingSteerProjection.revision,
        ...ports.controlState(id, clientId),
      };
    }
    return ports.coldSessionView(id, session, turnLimit, clientId);
  }
