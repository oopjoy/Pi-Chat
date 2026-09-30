import type {
  GateMode,
  InitialPromptData,
  PendingSteer,
  ModelInfo,
  PiMessage,
  PromptImage,
  PromptSettingsSnapshot,
  QueuedPrompt,
  SessionViewData,
  ThinkingLevel,
} from "../../shared/types";
import type { LocalUserTurn } from "../lib/local-user-turn";
import { nextLocalTurnTotal } from "../lib/local-user-turn";
import {
  promptSettingsForSelection,
  type SessionComposerSelection,
} from "../lib/session-composer-selection";
import type { PromptOperation, PromptOperationEvent } from "./prompt-operation";
import {
  promptPhaseForError,
  promptPhaseForResult,
  type PromptResultFacts,
  type PromptSubmitController,
} from "./prompt-submit-controller";
import type { PromptAdmissionInput } from "./prompt-coordinator";

export interface PromptSubmitFlowDependencies {
  controller: PromptSubmitController;
  isResultPending: (error: unknown) => boolean;
  isExplicitClientRejection: (error: unknown, resultPending: boolean) => boolean;
}

export interface PromptSubmitAdmissionFacts {
  promptSubmitted: boolean;
  promptAcceptedByEvent: boolean;
  promptTerminalByEvent: boolean;
}

export function promptSettledBeforeAcknowledgement(input: {
  promptTerminalByEvent: boolean;
  eventVersionAfter: number;
  eventVersionBefore: number;
  lastEventType: string | undefined;
}): boolean {
  return input.promptTerminalByEvent
    || (
      input.eventVersionAfter > input.eventVersionBefore
      && (input.lastEventType === "agent_settled"
        || input.lastEventType === "pi_chat_process_error")
    );
}

export interface PromptFailureClassification {
  outcomeUnknown: boolean;
  failureIsDefinite: boolean;
}

export function classifyPromptFailure(input: {
  resultPending: boolean;
  promptSubmitted: boolean;
  promptAcceptedByEvent: boolean;
  promptTerminalByEvent: boolean;
  explicitClientRejection: boolean;
  upstreamOutcomeUnknown: boolean;
}): PromptFailureClassification {
  const outcomeUnknown =
    input.resultPending
    || (
      input.promptSubmitted
      && (
        input.promptAcceptedByEvent
        || input.promptTerminalByEvent
        || !input.explicitClientRejection
      )
    );
  return {
    outcomeUnknown,
    failureIsDefinite:
      !input.resultPending
      && !input.upstreamOutcomeUnknown
      && !(input.promptAcceptedByEvent && !input.promptTerminalByEvent),
  };
}

export type PromptPreparationRoute = "draft" | "restore" | "active";

export type PromptAcknowledgementKind = "extension" | "steer" | "queued" | "ordinary";

export function promptAcknowledgementKind(result: {
  extension?: boolean;
  steered?: boolean;
  queued?: boolean;
}): PromptAcknowledgementKind {
  if (result.extension) return "extension";
  if (result.steered) return "steer";
  if (result.queued) return "queued";
  return "ordinary";
}

export interface AcknowledgedTurnPlan {
  promoteFromQueue: boolean;
  markDispatched: boolean;
}

export function planAcknowledgedTurn(input: {
  kind: PromptAcknowledgementKind;
  acceptedTurnPresent: boolean;
  resultId: string | undefined;
  currentQueue: QueuedPrompt[] | undefined;
}): AcknowledgedTurnPlan {
  return {
    promoteFromQueue:
      input.kind === "queued"
      && input.acceptedTurnPresent
      && Boolean(input.resultId)
      && Boolean(
        input.currentQueue
        && !input.currentQueue.some((item) => item.id === input.resultId),
      ),
    markDispatched:
      input.kind === "ordinary" && input.acceptedTurnPresent,
  };
}

export function pendingSteerFromAcknowledgement(input: {
  steered: boolean;
  queueState: "waiting" | "dispatched" | undefined;
  queueId: string | undefined;
  message: string;
  imageCount: number;
  createdAt: number;
}): PendingSteer | null {
  if (!input.steered || input.queueState !== "waiting" || !input.queueId)
    return null;
  return {
    id: input.queueId,
    message: input.message || "请查看这些图片。",
    imageCount: input.imageCount,
    createdAt: input.createdAt,
  };
}

export interface AcknowledgedQueueProjectionPlan {
  accepted: boolean;
  queue: QueuedPrompt[];
  paused: boolean;
}

export function planAcknowledgedQueueProjection(input: {
  incoming: QueuedPrompt[] | undefined;
  incomingPaused: boolean;
  currentRevision: number;
  requestRevision: number;
  current: { queue: QueuedPrompt[]; paused: boolean };
  source: "event" | "view" | "ack" | "mutation" | undefined;
  resultQueued: boolean;
  resultId: string | undefined;
  acknowledgedTurnQueueId?: string;
  acknowledgedTurnQueueState?: "waiting" | "dispatched";
}): AcknowledgedQueueProjectionPlan | undefined {
  if (!input.incoming) return undefined;
  if (input.currentRevision === input.requestRevision)
    return { accepted: true, queue: input.incoming, paused: input.incomingPaused };
  if (input.source === "event" || input.source === "mutation")
    return { accepted: false, ...input.current };
  if (!input.resultQueued || !input.resultId)
    return { accepted: false, ...input.current };
  if (
    input.acknowledgedTurnQueueId === input.resultId
    && input.acknowledgedTurnQueueState === "dispatched"
  ) return { accepted: false, ...input.current };
  const admitted = input.incoming.find((item) => item.id === input.resultId);
  if (!admitted || input.current.queue.some((item) => item.id === admitted.id))
    return { accepted: false, ...input.current };
  return {
    accepted: true,
    queue: [...input.current.queue, admitted],
    paused: input.current.paused,
  };
}

export async function prepareRestoringPrompt<TAuthority, TReady>(input: {
  sessionId: string;
  authority: TAuthority;
  dispatchPreparing: (authority: TAuthority, sessionId: string) => void;
  protectLocalTurn: () => void;
  warmRuntime: (sessionId: string) => Promise<TReady>;
  isCurrent: () => boolean;
  applyWarmReadiness: (sessionId: string, ready: TReady, authority: TAuthority) => boolean;
  commitPreparing: (authority: TAuthority, sessionId: string) => void;
}): Promise<{ cancelled: boolean; ready?: TReady }> {
  input.dispatchPreparing(input.authority, input.sessionId);
  input.protectLocalTurn();
  const ready = await input.warmRuntime(input.sessionId);
  if (!input.isCurrent()) return { cancelled: true };
  if (input.applyWarmReadiness(input.sessionId, ready, input.authority))
    input.commitPreparing(input.authority, input.sessionId);
  return { cancelled: false, ready };
}

export function promptPreparationRoute(input: {
  isDraft: boolean;
  runtimeStatus: string;
  alreadyStreaming: boolean;
}): PromptPreparationRoute {
  if (input.isDraft) return "draft";
  if (input.runtimeStatus !== "active") return "restore";
  return "active";
}

export interface NewDraftPromptInput {
  cwd?: string;
  message: string;
  images: PromptImage[];
  model?: ModelInfo | null;
  thinkingLevel?: ThinkingLevel;
  gateMode?: GateMode;
  clientPromptOperationId?: string;
  promptSettings?: PromptSettingsSnapshot;
}

export interface NewDraftPromptTransport {
  submitNewSession?: (input: NewDraftPromptInput) => Promise<InitialPromptData>;
  newSession: (cwd?: string) => Promise<SessionViewData>;
  prompt: (
    message: string,
    images: PromptImage[],
    sessionId: string,
    gateMode?: GateMode,
    settings?: PromptSettingsSnapshot,
    clientPromptOperationId?: string,
  ) => Promise<{
    promptId?: string;
    deliveryUncertain?: boolean;
  }>;
  isCurrent: () => boolean;
}

export async function submitNewDraftPrompt(
  transport: NewDraftPromptTransport,
  input: NewDraftPromptInput,
): Promise<InitialPromptData> {
  if (transport.submitNewSession) {
    const { promptSettings: _promptSettings, ...combinedInput } = input;
    return transport.submitNewSession(combinedInput);
  }
  const view = await transport.newSession(input.cwd);
  if (!transport.isCurrent())
    throw new Error("服务已切换，已取消旧进程的新对话提交");
  const promptResult = await transport.prompt(
    input.message,
    input.images,
    view.session.id,
    input.gateMode,
    input.promptSettings,
    input.clientPromptOperationId,
  );
  return {
    sessionId: view.session.id,
    session: view.session,
    state: view.state,
    gateMode: view.gateMode || "strict",
    accepted: true,
    queued: false,
    ...(promptResult.promptId ? { promptId: promptResult.promptId } : null),
    ...(promptResult.deliveryUncertain ? { deliveryUncertain: true } : null),
  };
}

export function initialDraftSessionView(initial: InitialPromptData): SessionViewData {
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

export interface DraftIntentMigration {
  selectionForTarget?: SessionComposerSelection;
  gateModeForTarget?: GateMode;
  clearDraftSelection: boolean;
  clearDraftGateMode: boolean;
}

export function draftIntentAfterSubmit(input: {
  capturedSelection: SessionComposerSelection | undefined;
  newestDraftSelection: SessionComposerSelection | undefined;
  capturedGateMode: GateMode | undefined;
  newestDraftGateMode: GateMode | undefined;
}): DraftIntentMigration {
  return {
    selectionForTarget:
      input.newestDraftSelection
      && input.newestDraftSelection.revision !== input.capturedSelection?.revision
        ? input.newestDraftSelection
        : undefined,
    gateModeForTarget:
      input.newestDraftGateMode
      && input.newestDraftGateMode !== input.capturedGateMode
        ? input.newestDraftGateMode
        : undefined,
    clearDraftSelection: true,
    clearDraftGateMode: true,
  };
}

export interface CapturedPromptSelection {
  selection?: SessionComposerSelection;
  promptSettings?: PromptSettingsSnapshot;
  draftGateMode?: GateMode;
}

export function capturePromptSelection(input: {
  stagedSelection: SessionComposerSelection | undefined;
  models: readonly ModelInfo[];
  isDraft: boolean;
  draftGateMode: GateMode | undefined;
}): CapturedPromptSelection {
  const selection = input.stagedSelection
    ? {
        ...input.stagedSelection,
        ...(input.stagedSelection.model
          ? { model: { ...input.stagedSelection.model } }
          : null),
      }
    : undefined;
  return {
    ...(selection ? { selection } : null),
    promptSettings: promptSettingsForSelection(selection, input.models),
    ...(input.isDraft ? { draftGateMode: input.draftGateMode } : null),
  };
}

export interface LocalPromptProtectionInput {
  turn: PiMessage | null;
  targetSessionId: string;
  viewedSessionId: string;
  protectedLocalTurn: LocalUserTurn | null;
  pendingTurns: LocalUserTurn[];
  promptOperationId: string;
  messages: PiMessage[];
  turnTotal: number | undefined;
  willQueueLocally: boolean;
  steering: boolean;
  message: string;
  images: PromptImage[];
  baselineTurnTotal: number | undefined;
}

export function buildProtectedLocalTurn(
  input: LocalPromptProtectionInput,
): LocalUserTurn | null {
  if (
    !input.turn
    || !input.targetSessionId
    || input.targetSessionId !== input.viewedSessionId
    || input.protectedLocalTurn
  ) return null;
  return {
    sessionId: input.targetSessionId,
    message: input.turn,
    promptOperationId: input.promptOperationId,
    expectedTurnTotal: nextLocalTurnTotal(
      input.messages,
      input.turnTotal,
      input.pendingTurns,
    ),
    baselineTurnTotal: input.baselineTurnTotal,
    queueState:
      (input.willQueueLocally || input.steering) && !input.message.startsWith("/")
        ? "waiting"
        : undefined,
    ...(input.steering
      ? { revealOnMessageStart: true, queueId: crypto.randomUUID() }
      : null),
    confirmByPosition: input.images.length > 0,
  };
}

export interface PromptSubmitFlow {
  admit<TResult extends PromptResultFacts>(input: {
    admission: PromptAdmissionInput;
    execute: (operation: PromptOperation) => Promise<TResult>;
    facts: PromptSubmitAdmissionFacts;
  }): Promise<TResult>;
  phaseForResult(result: PromptResultFacts): Extract<PromptOperationEvent, { type: "queue" | "run" | "uncertain" }>;
}

/**
 * Owns the Prompt admission transaction boundary used by App's send flow.
 * Local turns, queue state, panes and React effects remain App-owned; this
 * flow only coordinates server admission with the existing Prompt authority.
 */
export function createPromptSubmitFlow(
  dependencies: PromptSubmitFlowDependencies,
): PromptSubmitFlow {
  const { controller, isResultPending, isExplicitClientRejection } = dependencies;
  return {
    admit: <TResult extends PromptResultFacts>({ admission, execute, facts }: {
      admission: PromptAdmissionInput;
      execute: (operation: PromptOperation) => Promise<TResult>;
      facts: PromptSubmitAdmissionFacts;
    }) => controller.admit({
      input: admission,
      execute,
      options: {
        phaseForResult: (result) => controller.phaseForResult(result),
        phaseForError: (error) => promptPhaseForError({
          error,
          ...facts,
          isResultPending,
          isExplicitClientRejection,
        }),
      },
    }),
    phaseForResult: (result) => promptPhaseForResult(result),
  };
}
