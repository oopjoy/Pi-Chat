import type { IncomingMessage, ServerResponse } from "node:http";

type ApplicationShutdownReason = any;
type PiChatApp = any;
type SessionIndex = any;

export async function handleApiCoreRoute(
  host: Record<string, any>,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  preparedBody?: Record<string, unknown>,
): Promise<void> {
  const {
    ApplicationLifecycleConflictError,
    DEFAULT_DIRECTORY_SESSION_LIST_SIZE,
    MAX_DIRECTORY_SESSION_LIST_SIZE,
    MAX_NATIVE_STEERING,
    MAX_NATIVE_STEERING_IMAGE_CHARS,
    MAX_PENDING_PROMPT_BASELINE_IDS,
    MAX_TURN_WINDOW_SIZE,
    PROMPT_BODY_LIMIT,
    PROMPT_PREPARE_TIMEOUT_MS,
    PartialTurnSettingsError,
    Proxy,
    RECENT_TURN_WINDOW_SIZE,
    Reflect,
    TURN_WINDOW_INCREMENT,
    asState,
    bodyJson,
    clearInterval,
    dequeueNativeSteering,
    dispatchNewDraftFirstTurn,
    gateModeFromCommand,
    handleBootstrapRoute,
    handleDiagnosticsReadRoute,
    handleExtensionResponseRoute,
    handleLifecycleControlRoute,
    handleLocalFilesWorkspaceRoute,
    handleModelManagementRoute,
    handleNewSessionRoute,
    handlePromptRoute,
    handleQueueControlRoute,
    handleResourcesReadRoute,
    handleSessionMutationsRoute,
    handleSessionRuntimeControlRoute,
    handleSessionsReadRoute,
    handleSubagentsReadRoute,
    handleWindowControlRoute,
    handleWorkspaceControlRoute,
    handleWorkspaceOpenRoute,
    handleWorkspaceReadRoute,
    json,
    methodNotAllowed,
    pickLocalFiles,
    pickWorkspaceFolder,
    randomUUID,
    readClipboardFiles,
    renameSession,
    requestClientId,
    requestPageId,
    requiredSessionId,
    respondToExtension,
    setInterval,
  } = host;

    const clientId = requestClientId(request);
    if (
      await handleDiagnosticsReadRoute(
        {
          isRegisteredWindowPage: (client: any, page: any) => host.connectedPageClients.get(page) === client,
          checkpoint: () => host.streamDiagnostics.checkpoint(),
          snapshot: () => host.stateDiagnostics.snapshot(),
        },
        request,
        response,
        url,
      )
    )
      return;
    if (
      await handleBootstrapRoute(
        {
          lifecycle: () => host.applicationLifecycle,
          assertBootstrapAllowed: () => {
            if (host.applicationLifecycle !== "idle")
              throw new ApplicationLifecycleConflictError(
                host.applicationLifecycle,
                host.lifecycleMessage(),
              );
          },
          requestToken: () => host.requestToken,
          buildIdentity: () => host.buildIdentity,
          openWindowCount: () => host.openWindowCount(),
          cancelLastWindowShutdown: () => host.cancelLastWindowShutdown(),
          scheduleLastWindowShutdown: () => host.scheduleLastWindowShutdown(),
          registerWindowPage: (id: any, pageId: any) =>
            host.registerWindowPage(id, pageId),
          bootstrap: async (id: any) => {
            const data = await host.bootstrap(id);
            host.traceBootstrapProjection(data);
            return data;
          },
        },
        request,
        response,
        url,
        clientId,
      )
    )
      return;
    if (
      await handleSubagentsReadRoute(
        {
          backgroundSubagents: (sessionId: any) => host.backgroundSubagentsRoute(sessionId),
          backgroundSubagentView: (input: any) => host.backgroundSubagentViewRoute(input),
        },
        request,
        response,
        url,
        clientId,
        {
          recentTurns: RECENT_TURN_WINDOW_SIZE,
          maxTurns: MAX_TURN_WINDOW_SIZE,
          turnIncrement: TURN_WINDOW_INCREMENT,
        },
      )
    )
      return;
    if (
      await handleWorkspaceOpenRoute(
        {
          openWorkspaceFile: (input: any) => host.workspaceOpenFileRoute(input),
          openLinkedWorkspaceFile: (input: any) => host.workspaceOpenLinkedFileRoute(input),
        },
        request,
        response,
        url,
        preparedBody,
      )
    )
      return;
    if (
      await handleWorkspaceReadRoute(
        {
          workspaceRecentFiles: (input: any) => host.workspaceRecentFilesRoute(input),
          workspaceFile: (input: any) => host.workspaceFileRoute(input),
        },
        request,
        response,
        url,
      )
    )
      return;
    if (
      await handleResourcesReadRoute(
        {
          resources: host.options.resources,
          primaryRuntimeCwd: () => host.primaryRuntimeCwd,
        },
        request,
        response,
        url,
      )
    )
      return;
    if (
      await handleSessionsReadRoute(
        {
          listSessions: (input: any) => host.listSessionsRoute(input),
          sessionView: (input: any) => host.sessionViewRoute(input),
        },
        request,
        response,
        url,
        clientId,
        {
          recentTurns: RECENT_TURN_WINDOW_SIZE,
          maxTurns: MAX_TURN_WINDOW_SIZE,
          turnIncrement: TURN_WINDOW_INCREMENT,
          directoryLimit: DEFAULT_DIRECTORY_SESSION_LIST_SIZE,
          maxDirectoryLimit: MAX_DIRECTORY_SESSION_LIST_SIZE,
        },
      )
    )
      return;

    if (
      await handleWindowControlRoute(
        {
          assertIdle: () => {
            if (host.applicationLifecycle !== "idle")
              throw new ApplicationLifecycleConflictError(
                host.applicationLifecycle,
                host.lifecycleMessage(),
              );
          },
          isConnectedWindowPage: (client: any, page: any) => host.isConnectedWindowPage(client, page),
          noteClientPresence: (client: any, page: any, revision: any, foreground: any) =>
            foreground
              ? host.sessionControl.noteClientPresence(client, page, revision)
              : host.sessionControl.noteClientBackground(client, page, revision),
          isClientPresent: (client: any) => host.sessionControl.isClientPresent(client),
          closeWindowClient: (client: any, page: any) => host.closeWindowClient(client, page),
          openWindowCount: () => host.openWindowCount(),
          activeMutationRequests: () => host.activeMutationRequests,
          runtimeStartingCount: () => host.runtimePool.startingCount,
          restSessionAfterWindowClose: (sessionId: any) => host.restSessionAfterWindowClose(sessionId),
          scheduleLastWindowShutdown: () => host.scheduleLastWindowShutdown(),
          lastWindowAutoShutdownEnabled: () => host.lastWindowAutoShutdownEnabled,
          applicationShutdownAvailable: () => Boolean(host.options.applicationShutdown),
        },
        request,
        response,
        url,
      )
    )
      return;

    if (
      await handleLifecycleControlRoute(
        {
          applicationShutdownAvailable: () => Boolean(host.options.applicationShutdown),
          applicationRestartAvailable: () => Boolean(host.options.applicationRestart),
          isConnectedWindowPage: (client: any, page: any) => host.isConnectedWindowPage(client, page),
          beginLifecycle: (lifecycle: any) => host.beginLifecycle(lifecycle),
          endLifecycle: (lifecycle: any) => host.endLifecycle(lifecycle),
          verifyApplicationQuiescent: (reason: any) => host.verifyApplicationQuiescent(reason),
          broadcast: (event: any) => host.broadcast(event),
          shutdown: (reason: any) => host.options.applicationShutdown?.(reason as any),
          restart: () => host.options.applicationRestart!(),
          reportIncident: (error: any, input: any) => host.reportIncident(
            error,
            input as any,
          ),
        },
        request,
        response,
        url,
      )
    )
      return;

    if (
      await handleLocalFilesWorkspaceRoute(
        {
          pickLocalFiles: () => pickLocalFiles(),
          readClipboardFiles: (files: any) => readClipboardFiles(files),
          pickWorkspaceFolder: (cwd: any) => (host.options.pickWorkspaceFolder || pickWorkspaceFolder)(cwd),
          currentCwd: () => host.currentCwd,
        },
        request,
        response,
        url,
      )
    )
      return;

    if (url.pathname === "/api/events") {
      if (request.method !== "GET") return methodNotAllowed(response);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      // A browser commonly opens SSE only after its initial bootstrap. Include
      // the current Primary capability snapshot here so a fast start that
      // completes between those two connections cannot leave the client pinned
      // forever to bootstrap's earlier `starting` state.
      response.write(
        `event: ready\ndata: ${JSON.stringify({ ok: true, lifecycle: host.applicationLifecycle, piChatRunEpoch: host.runEpoch, workspaceEpoch: host.runEpoch, primaryRuntime: host.primaryReadiness() })}\n\n`,
      );
      host.traceState("sse", "ready", host.activeSessionId, {
        lifecycle: host.applicationLifecycle,
        primaryStatus: host.primaryReadiness().status,
      });
      const pageId = requestPageId(request) || clientId;
      host.sseHub.add(response, clientId, {
        streamingDelta: url.searchParams.get("stream") === "delta-v1",
      });
      host.ssePageByResponse.set(response, pageId);
      host.clientConnected(clientId, pageId);
      host.traceState("sse", "connected", host.activeSessionId, {
        openWindows: host.openWindowCount(),
      });
      const timer = setInterval(
        () => host.sseHub.heartbeat(response),
        host.sseHeartbeatMs,
      );
      request.once("close", () => {
        clearInterval(timer);
        // The hub emits exactly one disconnect notification. If a slow-client
        // protection already removed this response, remove() is a harmless no-op.
        host.sseHub.remove(response);
      });
      return;
    }

    if (url.pathname === "/api/chat/steers/dequeue") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const requestedSessionId = requiredSessionId(body);
      const result = await dequeueNativeSteering(
        {
          beginPromptAdmission: (sessionId: any) => host.beginPromptAdmission(sessionId),
          resolveTarget: (sessionId: any) => {
            const requestedIsPrimary = Boolean(host.activeSessionId) && sessionId === host.activeSessionId;
            const runtime = requestedIsPrimary ? null : host.runtimePool.get(sessionId) || null;
            if (!requestedIsPrimary && !runtime) return null;
            return {
              rpc: runtime?.rpc || host.options.rpc,
              generation: requestedIsPrimary ? host.primaryRpcGeneration : (runtime?.rpcGeneration || 0),
              releaseRuntimeAdmission: runtime
                ? host.runtimePool.acquireOperation(runtime)
                : host.primaryOperationAdmission.acquire().release,
            };
          },
          completed: (dequeueId: any) => host.nativeSteeringDequeueResults.get(dequeueId),
          settle: (sessionId: any, dequeueId: any, items: any, generation: any) => host.settleNativeSteeringDequeue(
            sessionId,
            { dequeueId, steering: items },
            generation,
          ),
          forget: (dequeueId: any) => host.nativeSteeringDequeueResults.delete(dequeueId),
        },
        requestedSessionId,
      );
      return json(response, 200, result);
    }

    if (url.pathname === "/api/chat/prompt") {
      const promptHost = new Proxy(host as any, {
        get: (target: any, property: any) => Reflect.get(target, property, target),
        set: (target: any, property: any, value: any) => Reflect.set(target, property, value, target),
      });
      Object.assign(promptHost, {
        PROMPT_BODY_LIMIT,
        PROMPT_PREPARE_TIMEOUT_MS,
        MAX_NATIVE_STEERING,
        MAX_NATIVE_STEERING_IMAGE_CHARS,
        MAX_PENDING_PROMPT_BASELINE_IDS,
        gateModeFromCommand,
      });
      await handlePromptRoute(promptHost, request, response, url, preparedBody);
      return;
    }

    if (
      await handleQueueControlRoute(
        {
          target: (sessionId: any) => {
            const runtime = host.runtimePool.get(sessionId);
            if (runtime)
              return {
                queue: runtime.promptQueue,
                getPaused: () => runtime.queuePaused,
                setPaused: (paused: any) => { runtime.queuePaused = paused; },
                touch: () => host.runtimePool.touch(runtime),
                recover: host.secondaryNeedsRecovery(runtime)
                  ? () => host.recoverRuntime(runtime)
                  : undefined,
                dispatch: () => { void host.dispatchRuntimeNext(runtime); },
              };
            if (sessionId !== host.activeSessionId) return null;
            return {
              queue: host.promptQueue,
              getPaused: () => host.queuePaused,
              setPaused: (paused: any) => { host.queuePaused = paused; },
              touch: () => {},
              dispatch: () => { void host.dispatchNext(); },
            };
          },
          publicQueue: (queue: any) => host.publicQueue(queue),
          traceCancelled: (sessionId: any, queueId: any) =>
            host.tracePrompt("cancelled", sessionId, queueId),
          broadcastQueue: (sessionId: any) => host.broadcastQueue(sessionId),
        },
        request,
        response,
        url,
        preparedBody,
      )
    ) return;

    if (
      await handleWorkspaceControlRoute(
        {
          currentCwd: () => host.currentCwd,
          pickWorkspaceFolder: (cwd: any) =>
            (host.options.pickWorkspaceFolder || pickWorkspaceFolder)(cwd),
          changeWorkspace: (path: any) => host.changeWorkspace(path),
          bootstrap: () => host.bootstrap(),
        },
        request,
        response,
        url,
        preparedBody,
      )
    ) return;

    if (url.pathname === "/api/chat/compact") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const sessionId = requiredSessionId(body);
      const customInstructions =
        typeof body.customInstructions === "string"
          ? body.customInstructions.trim()
          : "";
      await host.compactSession(sessionId, customInstructions, (result: any) => {
        if (result.kind === "conflict")
          json(response, 409, {
            error: result.error,
            ...(result.code ? { code: result.code } : null),
          });
        else json(response, 200, { result: result.result });
      });
      return;
    }

    if (url.pathname === "/api/chat/abort") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const sessionId = requiredSessionId(body);
      const runtime = host.runtimePool.get(sessionId);
      if (runtime) {
        await host.abortSecondaryRuntime(sessionId, runtime, (result: any) =>
          json(response, 200, result),
        );
        return;
      }
      if (sessionId !== host.activeSessionId)
        return json(response, 409, { error: "该会话不是活动运行会话" });
      await host.abortPrimaryRuntime(sessionId, (result: any) => json(response, 200, result));
      return;
    }

    if (
      await handleSessionMutationsRoute(
        {
          requireSessionControl: (sessionId: any, client: any) => host.requireSessionControl(sessionId, client),
          beginPromptAdmission: (sessionId: any) => host.beginPromptAdmission(sessionId),
          renameSession: (sessionId: any, name: any) => renameSession({
            sessionMutationOutcomePending: (id: any) => host.sessionMutationOutcomePending(id),
            activeSessionId: () => host.activeSessionId,
            knownRuntime: (id: any) => host.runtimePool.get(id),
            ensureRuntime: (id: any) => host.ensureRuntime(id),
            primaryRpc: () => host.options.rpc,
            acquireRuntimeOperation: (runtime: any) => host.runtimePool.acquireOperation(runtime),
            acquirePrimaryOperation: () => host.primaryOperationAdmission.acquire().release,
            lateRpcOutcomeHandler: (id: any, token: any) => host.lateRpcOutcomeHandler(id, token, "generic"),
            markRpcOutcomePending: (id: any, error: any, token: any) => host.markRpcOutcomePending(id, error, token),
            rethrowResultPending: (error: any, operation: any) => host.rethrowResultPending(error, operation),
            clearNativeSteeringState: (id: any, reason: any) => host.clearNativeSteeringState(id, reason),
            reclaimRuntime: (id: any) => host.runtimePool.reclaim(id, "idle").then(() => undefined),
            persistForkNameOverride: async (id: any, name: any) => {
              const applied = await host.sessionRelations.setNameOverride(id, name);
              if (applied) host.options.sessions.applyForkNameOverride(id, name);
            },
            updateRuntimeName: (id: any, name: any) => {
              if (id === host.activeSessionId && host.primarySummarySnapshot)
                host.primarySummarySnapshot = { ...host.primarySummarySnapshot, name };
              else {
                const runtime = host.runtimePool.get(id);
                if (runtime?.summarySnapshot)
                  runtime.summarySnapshot = { ...runtime.summarySnapshot, name };
              }
            },
            broadcastRenamed: (id: any) => host.broadcast({ type: "pi_chat_sessions_changed", action: "renamed", sessionId: id }),
          }, sessionId, name),
          deleteSession: (sessionId: any) => host.deleteSession(sessionId),
          copySession: (sessionId: any, mode: any, persistedMessageId: any) =>
            host.copySession(sessionId, mode, persistedMessageId),
        },
        request,
        response,
        url,
        clientId,
        preparedBody,
      )
    )
      return;

    if (
      await handleSessionRuntimeControlRoute(
        {
          activeSessionId: () => host.activeSessionId,
          runtimeExists: (sessionId: any) => host.runtimePool.has(sessionId),
          runtimeCanReclaim: (sessionId: any) => {
            const runtime = host.runtimePool.get(sessionId);
            return Boolean(runtime && host.runtimePool.canReclaim(runtime));
          },
          sweepRuntimes: () => { void host.runtimePool.sweep(); },
          clearViewed: (client: any, sessionId: any) => host.sessionControl.clearViewed(client, sessionId),
          knownSession: async (sessionId: any) => Boolean(
            (await (host.options.sessions as any).cachedSummaryForId?.(sessionId))
            || host.options.sessions.summaryForId?.(sessionId)
            || (await host.options.sessions.list(undefined, host.currentCwd)).some((session: any) => session.id === sessionId),
          ),
          markViewed: (client: any, sessionId: any) => host.markSessionViewed(client, sessionId),
          touchRuntime: (sessionId: any) => { const runtime = host.runtimePool.get(sessionId); if (runtime) host.runtimePool.touch(runtime); },
          ensurePrimaryIdentity: () => host.ensurePrimaryIdentity(),
          ensurePrimaryRuntime: () => host.ensurePrimaryRuntime(),
          ensureSecondaryRuntime: async (sessionId: any) => { await host.ensureRuntime(sessionId); },
          primaryReady: (sessionId: any) => ({
            sessionId,
            state: host.stateWithFastMode(sessionId, { ...host.lastPrimaryState, isStreaming: host.primaryTurnActive() }),
            gateMode: host.primaryGateMode,
          }),
          secondaryReady: (sessionId: any) => host.runtimeReady(host.runtimePool.get(sessionId)!),
          sessionView: (sessionId: any, browserId: any) => host.sessionView(sessionId, RECENT_TURN_WINDOW_SIZE, browserId),
          rethrowResultPending: (error: any, operation: any, fence: any = true) => host.rethrowResultPending(error, operation, fence),
        },
        request,
        response,
        url,
      )
    ) return;

    if (await handleNewSessionRoute({
      currentCwd: () => host.currentCwd,
      primaryNeedsRecovery: () => host.primaryNeedsRecovery(),
      waitForPrimaryCompatibility: () => host.waitForNewDraftPrimaryCompatibility(),
      acquireDraft: (owner: any, cwd: any) => host.acquireDraftRuntime(owner, cwd),
      rethrowResultPending: (error: any, operation: any) => host.rethrowResultPending(error, operation, false),
      markViewed: (owner: any, sessionId: any) => host.markSessionViewed(owner, sessionId),
      draftView: (runtime: any, owner: any) => host.draftSessionView(runtime, owner),
      beginPromptAdmission: (sessionId: any) => host.beginPromptAdmission(sessionId),
      firstTurn: async (runtime: any, input: any) => {
        const initialAbortGeneration = runtime.abortGeneration;
        const promptAt = host.nextUserPromptAt();
        const initialSettings: any = input.settings || {};
        const result = await dispatchNewDraftFirstTurn({
          requireControl: () => host.requireSessionControl(runtime.id, clientId),
          applySettings: () => host.applyTurnSettings(runtime.rpc, initialSettings, runtime.id),
          isPartialSettingsError: (error: any): error is any => error instanceof PartialTurnSettingsError,
          rememberPartialSettings: (applied: any) => host.rememberRuntimeAppliedTurnSettings(runtime, applied),
          rememberSettings: (applied: any) => host.rememberRuntimeAppliedTurnSettings(runtime, applied),
          assertCurrent: () => {
            if (initialAbortGeneration !== runtime.abortGeneration || host.applicationLifecycle !== "idle")
              throw new Error("消息发送已取消");
          },
          extensionCommand: (message: any) => host.extensionCommand(message, runtime.rpc),
          syncGate: () => host.syncGateMode(runtime.rpc, runtime.id, input.gateMode),
          setRunning: (running: any) => { runtime.running = running; },
          traceAdmitted: (id: any) => host.tracePrompt("admitted", runtime.id, id),
          broadcastActivity: () => host.broadcastSessionActivity(runtime.id),
          sendPrompt: (message: any, images: any, promptId: any) => host.sendPromptRpc(runtime.rpc, runtime.id, promptId, {
            type: "prompt", message, ...(images.length ? { images } : {}),
          }).then(() => undefined),
          sendExtensionPrompt: async (message: any) => { await runtime.rpc.send({ type: "prompt", message }, PROMPT_PREPARE_TIMEOUT_MS); },
          readState: async () => asState(await runtime.rpc.send({ type: "get_state" })),
          adoptExtensionState: async (state: any) => {
            runtime.lastState = state;
            runtime.running = state.isStreaming;
            runtime.prompted = true;
            host.noteUserPrompt(runtime.id, promptAt);
            await host.finalizePersistedDraft(runtime);
          },
          noteUserPrompt: () => host.noteUserPrompt(runtime.id, promptAt),
          notifyPromptAccepted: (id: any) => host.scheduler.notifySecondaryPromptAccepted(runtime, promptAt, input.message, input.images, initialSettings, id, input.clientPromptOperationId || undefined),
          traceDeliveryUncertain: (id: any) => host.tracePrompt("delivery-uncertain", runtime.id, id),
          readyData: () => host.runtimeReady(runtime),
          sessionData: () => ({ ...(runtime.draftSession || { id: runtime.id, sessionId: runtime.lastState?.sessionId || runtime.id, name: "新对话", preview: "新对话", cwd: runtime.cwd, updatedAt: host.now(), messageCount: 1, active: true }), active: true }),
          runtimeTurnActive: () => host.runtimeTurnActive(runtime),
          onFailure: () => { runtime.running = false; host.broadcastSessionActivity(runtime.id); },
        }, {
          message: input.message,
          images: input.images,
          promptId: input.message ? randomUUID() : "",
          settings: initialSettings,
        });
        return {
          ...result.ready,
          session: result.session,
          accepted: true,
          queued: false,
          ...(result.promptId ? { promptId: result.promptId } : null),
          ...(result.deliveryUncertain ? { deliveryUncertain: true } : null),
          ...(result.extension && !result.deliveryUncertain ? { extension: true, command: result.extension.name, description: result.extension.description, isStreaming: result.extension.isStreaming } : null),
        } satisfies Record<string, unknown>;
      },
      discardDraft: (runtime: any) => host.runtimePool.discardDraft(runtime).then(() => undefined),
    }, request, response, url, clientId, preparedBody)) return;

    if (
      await handleModelManagementRoute({
        available: () => Boolean(host.options.modelManager),
        providerService: () => host.providerManagementService(),
        customModelService: () => host.customModelManagementService(),
        runtimeSettingsService: () => host.runtimeSettingsService(),
        beginPromptAdmission: (sessionId: any) => host.beginPromptAdmission(sessionId),
      }, request, response, url, preparedBody)
    ) return;

    if (
      await handleExtensionResponseRoute({
        respond: (input: any) => respondToExtension({
          target: (sessionId: any) => {
            const runtime = host.runtimePool.get(sessionId);
            const rpc = runtime?.rpc || (sessionId === host.activeSessionId ? host.options.rpc : null);
            if (!rpc) return null;
            return {
              rpc,
              release: runtime
                ? host.runtimePool.acquireOperation(runtime)
                : host.primaryOperationAdmission.acquire().release,
            };
          },
          hasUncertain: (sessionId: any) => host.uncertainExtensionResponseBySession.has(sessionId),
          pendingRequest: (sessionId: any) => host.pendingRequestForSession(sessionId),
          claim: (key: any) => {
            if (host.claimingExtensionRequests.has(key)) return false;
            host.claimingExtensionRequests.add(key);
            return true;
          },
          releaseClaim: (key: any) => host.claimingExtensionRequests.delete(key),
          rpcOutcomeUnknown: (error: any) => host.rpcOutcomeUnknown(error),
          markOutcomePending: (sessionId: any, error: any) => host.markRpcOutcomePending(sessionId, error),
          markUncertain: (sessionId: any) => host.uncertainExtensionResponseBySession.add(sessionId),
          rethrowResultPending: (error: any, operation: any) => host.rethrowResultPending(error, operation),
          clearPending: (sessionId: any, requestId: any) => host.clearPendingRequest(sessionId, requestId),
        }, input),
      }, request, response, url, preparedBody)
    ) return;

    json(response, 404, { error: "API not found" });

}
