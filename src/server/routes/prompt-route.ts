import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApplicationLifecycle, GateMode, PiMessage, PromptImage, PromptSettingsSnapshot, QueuedPrompt } from "../../shared/types.js";
import type { PiChatAppOptions } from "../app.js";
import type { OperationAdmission } from "../operation-admission.js";
import type { PendingTurnSettings, RuntimePool } from "../runtime-pool.js";
import type { NativeSteeringAdmissions } from "../services/native-steering-admission.js";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";
import { RpcRequestTimeoutError } from "../rpc-client.js";
import { asState } from "../pi-data.js";
import { parsePromptRouteInput } from "./prompt-input.js";
import { requiredSessionId } from "./request-validation.js";
import { PartialTurnSettingsError } from "../runtime-pool.js";
import { admitNativeSteering } from "../services/native-steering-admission.js";
import { admitPromptExtension } from "../services/prompt-extension-admission.js";
import { admitPromptToQueue } from "../services/prompt-queue-admission.js";
import { dispatchPrimaryPrompt } from "../services/prompt-primary-dispatch.js";
import { dispatchSecondaryPrompt } from "../services/prompt-secondary-dispatch.js";

type PromptRouteCallback = (...args: any[]) => any;
type PromptRouteSchedulerPort = {
  primaryAbortGeneration: number;
  runtimeBusyForQueue: PromptRouteCallback;
  primaryBusyForQueue: PromptRouteCallback;
  assertCanEnqueue: PromptRouteCallback;
  enqueueRuntime: PromptRouteCallback;
  enqueuePrimary: PromptRouteCallback;
  notifySecondaryPromptAccepted: PromptRouteCallback;
};

export interface PromptRouteHost {
  PROMPT_BODY_LIMIT: number;
  PROMPT_PREPARE_TIMEOUT_MS: number;
  MAX_NATIVE_STEERING: number;
  MAX_NATIVE_STEERING_IMAGE_CHARS: number;
  MAX_PENDING_PROMPT_BASELINE_IDS: number;
  activeSessionId: string;
  activeSessionIds: () => string[];
  applicationLifecycle: ApplicationLifecycle;
  applyPromptSettings: PromptRouteCallback;
  advanceNativeSteeringProjection: (sessionId: string) => void;
  beginPromptAdmission: (sessionId: string) => Promise<() => void>;
  broadcast: PromptRouteCallback;
  broadcastQueue: (sessionId: string) => void;
  broadcastSessionActivity: (sessionId: string) => void;
  clearNativeSteeringState: (sessionId: string, reason: string) => void;
  clearPromptDiagnostic: (sessionId: string) => void;
  dispatchNext: () => void;
  dispatchRuntimeNext: (runtime: unknown) => void;
  dispatching: boolean;
  ensurePrimaryIdentity: () => Promise<void>;
  ensurePrimaryRuntime: () => Promise<void>;
  ensureRuntime: (sessionId: string) => Promise<unknown>;
  extensionCommand: PromptRouteCallback;
  finalizePersistedDraft: (runtime: unknown) => Promise<void>;
  gateModeFromCommand: (message: string) => GateMode | null;
  hasNativeSteeringPending: (sessionId: string, generation: number) => boolean;
  lastPrimaryMessages: PiMessage[];
  lastPrimaryMessagesSessionId: string;
  lateRpcOutcomeHandler: PromptRouteCallback;
  liveMessage: PiMessage | undefined;
  markRpcOutcomePending: PromptRouteCallback;
  nativeSteeringAdmissionsBySession: Map<string, NativeSteeringAdmissions>;
  nextUserPromptAt: () => number;
  noteUserPrompt: (sessionId: string, promptAt: number) => void;
  options: PiChatAppOptions;
  pendingTurnSettings: PendingTurnSettings | undefined;
  primaryOperationAdmission: OperationAdmission;
  primaryRpcGeneration: number;
  primaryTurnActive: () => boolean;
  promptQueue: QueuedPrompt[];
  publicQueue: PromptRouteCallback;
  queuePaused: boolean;
  recoverRuntime: (runtime: unknown) => Promise<void>;
  rememberRuntimeAppliedTurnSettings: (runtime: unknown, applied: unknown) => void;
  resetNativeSteering: (sessionId: string, runtime: unknown, reason: string) => Promise<void>;
  rethrowResultPending: PromptRouteCallback;
  rpcOutcomeUnknown: (error: unknown) => boolean;
  runtimePool: RuntimePool;
  runtimeTurnActive: (runtime: unknown) => boolean;
  running: boolean;
  scheduler: PromptRouteSchedulerPort;
  secondaryNeedsRecovery: (runtime: unknown) => boolean;
  sendPrompt: PromptRouteCallback;
  sendPromptRpc: PromptRouteCallback;
  sessionMutationOutcomePending: (sessionId: string) => boolean;
  setGateMode: (sessionId: string, mode: GateMode | undefined) => void;
  supersedePendingTurnSettings: (pending: PendingTurnSettings | undefined, settings: PromptSettingsSnapshot | undefined) => void;
  syncGateMode: PromptRouteCallback;
  toolStatus: string;
  tracePrompt: PromptRouteCallback;
}

export async function handlePromptRoute(host: PromptRouteHost, request: IncomingMessage, response: ServerResponse, url: URL, preparedBody?: Record<string, unknown>): Promise<void> {
  if (url.pathname !== "/api/chat/prompt") return;
  if (request.method !== "POST") return methodNotAllowed(response);
  const body = preparedBody || (await bodyJson(request, host.PROMPT_BODY_LIMIT));
  const promptInput = parsePromptRouteInput(body);
  const {
    message,
    sessionId: requestedSessionId,
    gateMode: requestedGateMode,
    settings: requestedSettings,
    delivery,
    steerId: requestedSteerId,
    clientPromptOperationId: requestedClientPromptOperationId,
    images,
  } = promptInput;
  const promptAt = host.nextUserPromptAt();
  const admittedSessionId = requestedSessionId;
  const releasePromptAdmission =
    await host.beginPromptAdmission(admittedSessionId);
  let releaseRuntimeAdmission: (() => void) | null = null;
  try {
    // Before creating a *new* Secondary, bind Primary identity through the
    // readiness gate. An already-owned Secondary remains usable even if the
    // independent Primary startup subsequently fails.
    const existingSecondary =
      host.runtimePool.get(requestedSessionId) || null;
    // Steering changes an already-running agent. It must never wake a cold
    // Session, recover a failed worker, or bind a new Primary identity.
    if (delivery === "steer") {
      const requestedIsPrimary =
        Boolean(host.activeSessionId) &&
        requestedSessionId === host.activeSessionId;
      const steeringRuntime = requestedIsPrimary
        ? null
        : existingSecondary;
      const targetRpc = steeringRuntime?.rpc || host.options.rpc;
      const targetGeneration = requestedIsPrimary
        ? host.primaryRpcGeneration
        : (steeringRuntime?.rpcGeneration || 0);
      const targetAbortGeneration = requestedIsPrimary
        ? host.scheduler.primaryAbortGeneration
        : (steeringRuntime?.abortGeneration || 0);
      const targetRunning = requestedIsPrimary
        ? host.running || Boolean(host.liveMessage) || Boolean(host.toolStatus)
        : steeringRuntime?.running === true || Boolean(steeringRuntime?.liveMessage) || Boolean(steeringRuntime?.toolStatus);
      if (
        (!requestedIsPrimary && !steeringRuntime) ||
        !targetRunning ||
        targetRpc.isRunning?.() === false
      )
        return json(response, 409, {
          error: "当前对话未在运行，无法发送 Steer 消息",
          code: "STEER_NOT_RUNNING",
        });
      releaseRuntimeAdmission = steeringRuntime
        ? host.runtimePool.acquireOperation(steeringRuntime)
        : host.primaryOperationAdmission.acquire().release;
      const result = await admitNativeSteering({
        getAdmissions: () => host.nativeSteeringAdmissionsBySession.get(requestedSessionId),
        setAdmissions: (admissions) => {
          if (admissions)
            host.nativeSteeringAdmissionsBySession.set(requestedSessionId, admissions);
          else host.nativeSteeringAdmissionsBySession.delete(requestedSessionId);
        },
        advanceProjection: () => host.advanceNativeSteeringProjection(requestedSessionId),
        persistedMessages: () => requestedIsPrimary
          && host.lastPrimaryMessagesSessionId === requestedSessionId
            ? host.lastPrimaryMessages
            : steeringRuntime?.messageSnapshot
              || host.options.sessions.cachedSnapshotForId?.(requestedSessionId)?.messages
              || [],
        send: async (steeringMessage, steeringImages) => {
          await targetRpc.send({
            type: "steer",
            message: steeringMessage,
            ...(steeringImages.length ? { images: steeringImages } : {}),
          }, host.PROMPT_PREPARE_TIMEOUT_MS);
        },
        readStreaming: async () =>
          asState(await targetRpc.send({ type: "get_state" }, 2_000)).isStreaming,
        clearOnProcessError: () => host.clearNativeSteeringState(requestedSessionId, "process-error"),
        hasPending: (generation) => host.hasNativeSteeringPending(requestedSessionId, generation),
        reset: () => host.resetNativeSteering(
          requestedSessionId,
          steeringRuntime || undefined,
          "settled-before-consumption",
        ),
        afterReset: () => {
          if (steeringRuntime) {
            if (steeringRuntime.abortGeneration !== targetAbortGeneration) return;
            host.broadcastQueue(steeringRuntime.id);
            host.broadcastSessionActivity(steeringRuntime.id);
            if (
              !host.runtimeTurnActive(steeringRuntime) &&
              !steeringRuntime.dispatching &&
              !steeringRuntime.queuePaused
            )
              setTimeout(() => void host.dispatchRuntimeNext(steeringRuntime), 0);
          } else if (host.scheduler.primaryAbortGeneration === targetAbortGeneration) {
            host.broadcastQueue(requestedSessionId);
            host.broadcastSessionActivity(requestedSessionId);
            if (!host.primaryTurnActive() && !host.dispatching && !host.queuePaused)
              setTimeout(() => void host.dispatchNext(), 0);
          }
        },
      }, {
        generation: targetGeneration,
        message,
        images,
        requestedSteerId,
        hasSettings: Boolean(requestedSettings),
        promptAt,
        maxPending: host.MAX_NATIVE_STEERING,
        maxImageChars: host.MAX_NATIVE_STEERING_IMAGE_CHARS,
        maxBaselineIds: host.MAX_PENDING_PROMPT_BASELINE_IDS,
      });
      return json(response, result.status, result.body);
    }
    // Production readiness must bind the primary before allocating a worker;
    // legacy in-process test hosts have no startup controller and retain the
    // historical lazy identity behavior for their minimal RPC doubles.
    if (!host.activeSessionId && !existingSecondary) {
      try {
        await host.ensurePrimaryIdentity();
      } catch (error) {
        host.rethrowResultPending(error, "准备 Prompt Runtime", false);
      }
    }
    // A browser tab can outlive a Pi Chat restart. Restore its requested Session on demand
    // instead of rejecting the prompt because the old in-memory worker map was lost.
    const requestedIsPrimary = requestedSessionId === host.activeSessionId;
    if (
      !requestedIsPrimary &&
      !host.activeSessionIds().includes(requestedSessionId)
    ) {
      try {
        await host.ensureRuntime(requestedSessionId);
      } catch (error) {
        host.rethrowResultPending(error, "准备 Prompt Runtime", false);
      }
    }
    const secondaryRuntime = !requestedIsPrimary
      ? host.runtimePool.get(requestedSessionId) || null
      : null;
    // Capture cancellation intent before any Runtime recovery/readiness
    // await. The per-Session prompt admission above intentionally defines
    // a later queued submission as a new turn; an abort while waiting for
    // that admission cancels the currently executing turn, not this next
    // turn. Once admitted, however, abort must not be absorbed by a
    // generation captured after preparation has started.
    const secondaryBusyAtAdmission = secondaryRuntime
      ? host.scheduler.runtimeBusyForQueue(secondaryRuntime)
      : false;
    const primaryBusyAtAdmission = host.scheduler.primaryBusyForQueue();
    const expectedSecondaryAbortGeneration =
      secondaryRuntime && !secondaryBusyAtAdmission
        ? secondaryRuntime.abortGeneration
        : undefined;
    const expectedPrimaryAbortGeneration =
      secondaryRuntime || primaryBusyAtAdmission
        ? undefined
        : host.scheduler.primaryAbortGeneration;
    const expectedAbortGeneration = secondaryRuntime
      ? expectedSecondaryAbortGeneration
      : expectedPrimaryAbortGeneration;
    if (secondaryRuntime) {
      releaseRuntimeAdmission =
        host.runtimePool.acquireOperation(secondaryRuntime);
      host.runtimePool.touch(secondaryRuntime);
      if (host.secondaryNeedsRecovery(secondaryRuntime)) {
        try {
          await host.recoverRuntime(secondaryRuntime);
        } catch (error) {
          host.rethrowResultPending(error, "恢复 Prompt Runtime", false);
        }
      }
    } else {
      releaseRuntimeAdmission =
        host.primaryOperationAdmission.acquire().release;
      try {
        await host.ensurePrimaryRuntime();
      } catch (error) {
        host.rethrowResultPending(error, "准备 Prompt Runtime", false);
      }
    }
    const targetRpc = secondaryRuntime?.rpc || host.options.rpc;
    const targetSessionId = secondaryRuntime?.id || host.activeSessionId;
    if (host.sessionMutationOutcomePending(targetSessionId))
      return json(response, 409, {
        error: "上一次操作结果尚未确认；请刷新页面核对，不要重复发送",
        code: "RESULT_PENDING",
      });
    const extensionCommand = message
      ? await host.extensionCommand(message, targetRpc)
      : null;
    if (
      host.applicationLifecycle !== "idle" ||
      (
        expectedAbortGeneration !== undefined &&
        expectedAbortGeneration !==
          (secondaryRuntime
            ? secondaryRuntime.abortGeneration
            : host.scheduler.primaryAbortGeneration)
      )
    )
      throw new Error("消息发送已取消");
    if (extensionCommand) {
      const result = await admitPromptExtension({
        clearPromptDiagnostic: (sessionId) => host.clearPromptDiagnostic(sessionId),
        newOutcomeToken: () => randomUUID(),
        sendPrompt: async (extensionMessage, outcomeToken) => {
          await targetRpc.send(
            { type: "prompt", message: extensionMessage },
            host.PROMPT_PREPARE_TIMEOUT_MS,
            {
              onLateResponse: host.lateRpcOutcomeHandler(
                targetSessionId,
                outcomeToken,
                "generic",
              ),
            },
          );
        },
        outcomeUnknown: (error) => host.rpcOutcomeUnknown(error),
        markOutcomePending: (sessionId, error, token) =>
          host.markRpcOutcomePending(sessionId, error, token),
        rethrowResultPending: (error, operation, fence) =>
          host.rethrowResultPending(error, operation, fence) as never,
        requestedGateMode: (extensionMessage, commandName) =>
          commandName === "gate" ? host.gateModeFromCommand(extensionMessage) : null,
        setGateMode: (mode) => host.setGateMode(targetSessionId, mode),
        noteUserPrompt: (at) => host.noteUserPrompt(targetSessionId, at),
        readState: async () => asState(await targetRpc.send({ type: "get_state" })),
        confirmState: async (state) => {
          if (secondaryRuntime) {
            secondaryRuntime.running = state.isStreaming;
            secondaryRuntime.prompted = true;
            await host.finalizePersistedDraft(secondaryRuntime);
            host.broadcast({
              type: "pi_chat_sessions_changed",
              action: "created",
              sessionId: secondaryRuntime.id,
            });
          } else host.running = state.isStreaming;
        },
      }, {
        sessionId: targetSessionId,
        message,
        images,
        commandName: extensionCommand.name,
        commandDescription: extensionCommand.description || "",
        promptAt,
      });
      return json(response, result.status, result.body);
    }
    if (secondaryRuntime) {
      const queuedAdmission = admitPromptToQueue({
        isBusy: () => host.scheduler.runtimeBusyForQueue(secondaryRuntime),
        assertCanEnqueue: (queuedImages) =>
          host.scheduler.assertCanEnqueue(secondaryRuntime.promptQueue, queuedImages),
        enqueue: (queuedMessage, queuedImages, queuedAt, gateMode, settings, operationId) =>
          host.scheduler.enqueueRuntime(
            secondaryRuntime,
            queuedMessage,
            queuedImages,
            queuedAt,
            gateMode,
            settings,
            operationId,
          ),
        supersedePendingSettings: (settings) =>
          host.supersedePendingTurnSettings(secondaryRuntime.pendingTurnSettings, settings),
        publicQueue: () => host.publicQueue(secondaryRuntime.promptQueue),
        traceAdmitted: (queueId) => host.tracePrompt("admitted", secondaryRuntime.id, queueId),
        traceQueued: (queueId) => host.tracePrompt("queued", secondaryRuntime.id, queueId),
        noteUserPrompt: (queuedAt) => host.noteUserPrompt(secondaryRuntime.id, queuedAt),
      }, {
        message,
        images,
        promptAt,
        gateMode: requestedGateMode,
        settings: requestedSettings,
        clientPromptOperationId: requestedClientPromptOperationId || undefined,
      });
      if (queuedAdmission.kind === "conflict")
        return json(response, 409, { error: queuedAdmission.error });
      if (queuedAdmission.kind === "queued")
        return json(response, 202, {
          accepted: true,
          queued: true,
          id: queuedAdmission.item.id,
          promptId: queuedAdmission.item.id,
          queue: queuedAdmission.queue,
        });
      const promptId = randomUUID();
      const generation =
        expectedSecondaryAbortGeneration ?? secondaryRuntime.abortGeneration;
      const result = await dispatchSecondaryPrompt({
        applySettings: () => host.applyPromptSettings(
          secondaryRuntime.rpc,
          secondaryRuntime.pendingTurnSettings,
          requestedSettings,
          true,
          secondaryRuntime.id,
        ),
        isPartialSettingsError: (error): error is PartialTurnSettingsError =>
          error instanceof PartialTurnSettingsError,
        rememberPartialSettings: (applied) =>
          host.rememberRuntimeAppliedTurnSettings(secondaryRuntime, applied),
        rememberSettings: (applied) =>
          host.rememberRuntimeAppliedTurnSettings(secondaryRuntime, applied),
        assertCurrent: () => {
          if (
            generation !== secondaryRuntime.abortGeneration ||
            host.applicationLifecycle !== "idle"
          ) throw new Error("消息发送已取消");
        },
        syncGate: () => host.syncGateMode(
          secondaryRuntime.rpc,
          secondaryRuntime.id,
          requestedGateMode,
        ),
        setRunning: (running) => { secondaryRuntime.running = running; },
        traceAdmitted: () => host.tracePrompt("admitted", secondaryRuntime.id, promptId),
        broadcastActivity: () => host.broadcastSessionActivity(secondaryRuntime.id),
        sendPrompt: (promptMessage, promptImages) => host.sendPromptRpc(
          secondaryRuntime.rpc,
          secondaryRuntime.id,
          promptId,
          {
            type: "prompt",
            message: promptMessage,
            ...(promptImages.length ? { images: promptImages } : {}),
          },
        ).then(() => undefined),
        outcomeUnknown: (error) => host.rpcOutcomeUnknown(error),
        traceDeliveryUncertain: () =>
          host.tracePrompt("delivery-uncertain", secondaryRuntime.id, promptId),
        notifyAccepted: (settings) => host.scheduler.notifySecondaryPromptAccepted(
          secondaryRuntime,
          promptAt,
          message,
          images,
          settings,
          promptId,
          requestedClientPromptOperationId || undefined,
        ),
        onFailure: () => {
          secondaryRuntime.running = false;
          host.broadcastSessionActivity(secondaryRuntime.id);
        },
      }, {
        message,
        images,
        promptId,
        settings: requestedSettings,
      });
      return json(response, result.status, result.body);
    }
    const queuedAdmission = admitPromptToQueue({
      isBusy: () => host.scheduler.primaryBusyForQueue(),
      assertCanEnqueue: (queuedImages) =>
        host.scheduler.assertCanEnqueue(host.promptQueue, queuedImages),
      enqueue: (queuedMessage, queuedImages, queuedAt, gateMode, settings, operationId) =>
        host.scheduler.enqueuePrimary(
          queuedMessage,
          queuedImages,
          queuedAt,
          gateMode,
          settings,
          operationId,
        ),
      supersedePendingSettings: (settings) =>
        host.supersedePendingTurnSettings(host.pendingTurnSettings, settings),
      publicQueue: () => host.publicQueue(),
      traceAdmitted: (queueId) => host.tracePrompt("admitted", host.activeSessionId, queueId),
      traceQueued: (queueId) => host.tracePrompt("queued", host.activeSessionId, queueId),
      noteUserPrompt: (queuedAt) => host.noteUserPrompt(host.activeSessionId, queuedAt),
    }, {
      message,
      images,
      promptAt,
      gateMode: requestedGateMode,
      settings: requestedSettings,
      clientPromptOperationId: requestedClientPromptOperationId || undefined,
    });
    if (queuedAdmission.kind === "conflict")
      return json(response, 409, { error: queuedAdmission.error });
    if (queuedAdmission.kind === "queued") {
      json(response, 202, {
        accepted: true,
        queued: true,
        id: queuedAdmission.item.id,
        promptId: queuedAdmission.item.id,
        queue: queuedAdmission.queue,
      });
      return;
    }
    const promptId = randomUUID();
    const result = await dispatchPrimaryPrompt({
      sendPrompt: () => host.sendPrompt(
        message,
        images,
        promptAt,
        requestedGateMode,
        promptId,
        requestedSettings,
        expectedPrimaryAbortGeneration,
        requestedClientPromptOperationId || undefined,
      ),
      traceAdmitted: () => host.tracePrompt("admitted", host.activeSessionId, promptId),
      traceDeliveryUncertain: () => host.tracePrompt("delivery-uncertain", host.activeSessionId, promptId),
    }, promptId);
    return json(response, result.status, result.body);
  } finally {
    releaseRuntimeAdmission?.();
    releasePromptAdmission();
  }
}
