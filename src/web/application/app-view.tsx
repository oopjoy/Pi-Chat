import { Suspense } from "react";

export function AppView(host: Record<string, any>) {
  const {
    AppShell,
    AskQuestionnaireDialog,
    ChevronRightIcon,
    ConversationPane,
    DRAFT_FAILURE_SCOPE,
    api,
    EditDiffSidebar,
    ExtensionDialog,
    ManagementPanel,
    SessionDialog,
    SessionInventory,
    appearance,
    askQuestionnaires,
    buildIdentityLabel,
    buildIdentityMismatch,
    busy,
    cancelQueuedPrompt,
    changeModel,
    clearConversationNavigationTarget,
    composerCommands,
    composerControls,
    composerDraftKey,
    composerDraftKeyId,
    composerDraftRevisionsRef,
    composerHasContent,
    composerNotices,
    composerQueueMode,
    composerState,
    composerSubmissionPaused,
    composerSubmissionScope,
    composerTargetSessionId,
    confirmCloneSession,
    confirmForkSession,
    conversationWorkspace,
    copyingSessionIds,
    createSession,
    currentSessionBusyBeforeStreaming,
    deleteSession,
    dequeuePendingSteers,
    diagnosticsBusy,
    diffSidebarOpen,
    diffSidebarWidth,
    dispatchAskQuestionnaire,
    dispatchPane,
    displayedConversationName,
    displayedQueue,
    draftWorkspaceCwd,
    draftWorkspaceOptions,
    exportStateDiagnostics,
    extensionRequest,
    failedSessionIds,
    forgottenComposerKeys,
    forkMessagePreview,
    forkableUserMessageText,
    globalMutationBlocked,
    initialPaneUnresolved,
    inspectorSessionId,
    lastRunDurationMs,
    lifecycleBlocked,
    liveMessage,
    loadAllSessions,
    loadDirectorySessions,
    loadEarlierTurns,
    loading,
    loadingAllSessions,
    loadingDirectoryKeys,
    loadingEarlier,
    localDraft,
    localDraftRef,
    localFailures,
    managementSection,
    messageTotal,
    messages,
    messagesTruncated,
    modelCatalogueRevisionGate,
    modelRuntimeSyncPending,
    models,
    mutatingSessionIds,
    mutationBlocked,
    navigateConversation,
    navigateSubagentAncestor,
    newConversationPresentation,
    normalizeCwdKey,
    observing,
    onScroll,
    openSubagentSession,
    pane,
    paneLoading,
    pendingSteersBySession,
    pendingUserMessage,
    piVersion,
    pickDefaultWorkspace,
    pickDraftWorkspace,
    pinnedInventoryAttemptRef,
    primaryCapabilityPending,
    primaryRuntime,
    runtimeSetupDialog,
    openRuntimeSetup,
    queuePaused,
    recoveryActionBlocked,
    refreshManually,
    refreshing,
    renameSession,
    respondToExtension,
    restartPi,
    restoredComposerDrafts,
    resumeQueuedPrompt,
    runStartedAt,
    saveModelCatalog,
    scrollRef,
    selectDraftWorkspace,
    send,
    serverBuildIdentity,
    sessionActionBusy,
    sessionDialog,
    sessionDialogCopyBlocked,
    sessionDirectories,
    sessionNavigation,
    sessions,
    sessionsTotal,
    setAppearance,
    setComposerContentByScope,
    setDiffSidebarOpen,
    setDiffSidebarWidth,
    setError,
    setManagementSection,
    setModelRuntimeSyncPending,
    setModels,
    setSessionDialog,
    setSessionNavigation,
    setSidebarOpen,
    setSidebarWidth,
    shutdownPiChat,
    sidebarInventoryReady,
    sidebarOpen,
    sidebarViewBlocked,
    sidebarWidth,
    state,
    steerDequeueingBySession,
    stopGeneration,
    stoppingCurrentSession,
    subagentBreadcrumb,
    togglePinnedDirectory,
    togglePinnedSession,
    toolStatus,
    topBarSessionId,
    turnTotal,
    unseenReplySessionIds,
    updateComposerPending,
    viewSession,
    viewSwitching,
    viewedSession,
    viewedSessionId,
    viewedSessionIdRef,
    viewingSubagentSession,
    visibleTurnCount,
    waitingForPiMessage,
    webBuildIdentity,
    withoutPersistedFailure,
    workspaceActivityRevision,
    workspaceCwd,
    workspaceEpochRef,
    workspacePicking,
    workspaceRevisionRef,
  } = host;
  return (
    <AppShell
      diffSidebarOpen={diffSidebarOpen}
      diffSidebarWidth={diffSidebarWidth}
    >
      <SessionInventory
        sessions={sessions}
        sessionsTotal={sessionsTotal}
        sessionDirectories={sessionDirectories}
        inventoryReady={sidebarInventoryReady}
        loadingAllSessions={loadingAllSessions}
        loadingDirectoryKeys={loadingDirectoryKeys}
        viewedSessionId={viewedSessionId}
        workspaceCwd={workspaceCwd}
        workspaceEpoch={workspaceEpochRef.current}
        workspaceRevision={workspaceRevisionRef.current}
        open={sidebarOpen}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        newDisabled={mutationBlocked}
        refreshDisabled={loading || refreshing}
        restartDisabled={
          loading ||
          busy ||
          refreshing ||
          (buildIdentityMismatch
            ? recoveryActionBlocked
            : globalMutationBlocked)
        }
        copyDisabled={mutationBlocked}
        viewBusy={sidebarViewBlocked}
        refreshing={refreshing}
        pinnedSessionIds={sessionNavigation.pinnedSessionIds}
        pinnedDirectoryKeys={sessionNavigation.pinnedDirectoryKeys}
        collapsedDirectoryKeys={sessionNavigation.collapsedDirectoryKeys}
        expandedDirectoryKeys={sessionNavigation.expandedDirectoryKeys}
        failedSessionIds={failedSessionIds}
        unseenReplySessionIds={unseenReplySessionIds}
        mutatingSessionIds={[
          ...new Set([...mutatingSessionIds, ...copyingSessionIds]),
        ]}
        onClose={() => setSidebarOpen(false)}
        onCollapse={() => setSidebarOpen(false)}
        onNew={() => void createSession()}
        onRefresh={() => void refreshManually()}
        onLoadAllSessions={() => void loadAllSessions()}
        onLoadDirectory={(cwd: any, offset: any) =>
          void loadDirectorySessions(cwd, offset)
        }
        onRestart={() => void restartPi()}
        onView={(id: any) => {
          if (window.matchMedia?.("(max-width: 760px)").matches)
            setSidebarOpen(false);
          void viewSession(id);
        }}
        onTogglePin={(sessionId: any) => {
          pinnedInventoryAttemptRef.current = "";
          setSessionNavigation((current: any) => ({
            ...current,
            pinnedSessionIds: togglePinnedSession(
              current.pinnedSessionIds,
              sessionId,
            ),
          }));
        }}
        onToggleDirectoryPin={(cwd: any) =>
          setSessionNavigation((current: any) => ({
            ...current,
            pinnedDirectoryKeys: togglePinnedDirectory(
              current.pinnedDirectoryKeys,
              cwd,
            ),
          }))
        }
        onSetDirectoryCollapsed={(cwd: any, collapsed: any) =>
          setSessionNavigation((current: any) => {
            const key = normalizeCwdKey(cwd);
            if (!key) return current;
            return collapsed
              ? {
                  ...current,
                  collapsedDirectoryKeys: [
                    ...new Set([...current.collapsedDirectoryKeys, key]),
                  ],
                  expandedDirectoryKeys: current.expandedDirectoryKeys.filter(
                    (value: any) => value !== key,
                  ),
                }
              : {
                  ...current,
                  collapsedDirectoryKeys: current.collapsedDirectoryKeys.filter(
                    (value: any) => value !== key,
                  ),
                  expandedDirectoryKeys: [
                    ...new Set([...current.expandedDirectoryKeys, key]),
                  ],
                };
          })
        }
        onClone={(session: any) => setSessionDialog({ mode: "clone", session })}
        onRename={(session: any) => setSessionDialog({ mode: "rename", session })}
        onDelete={(session: any) => setSessionDialog({ mode: "delete", session })}
      />
      {!sidebarOpen && (
        <button
          type="button"
          className="sidebar-restore"
          onClick={() => setSidebarOpen(true)}
          title="展开会话栏"
          aria-label="展开会话栏"
        >
          <ChevronRightIcon />
        </button>
      )}
      <ConversationPane
        topBar={{
          sessionId: topBarSessionId,
          conversationName: displayedConversationName,
          workspacePath: conversationWorkspace,
          buildIdentity: buildIdentityMismatch
            ? `Web ${buildIdentityLabel(webBuildIdentity)}；服务 ${buildIdentityLabel(serverBuildIdentity)}`
            : `构建 ${buildIdentityLabel(serverBuildIdentity)}`,
          settingsOpen: managementSection !== null,
          onOpenSettings: () =>
            setManagementSection((current: any) => (current ? null : "settings")),
          diffSidebarOpen,
          onToggleDiffSidebar: () => setDiffSidebarOpen((open: any) => !open),
          onOpenSubagentSession: openSubagentSession,
          subagentBreadcrumb,
          onNavigateSubagentAncestor: navigateSubagentAncestor,
        }}
        timelineRef={scrollRef}
        onScroll={onScroll}
        onClearNavigation={clearConversationNavigationTarget}
        loading={loading}
        viewedSessionId={viewedSessionId}
        paneLoading={paneLoading}
        messages={messages}
        forkOrigin={pane.forkOrigin}
        onOpenForkSource={() => {
          const origin = pane.forkOrigin;
          if (!origin?.sourceAvailable || viewSwitching) return;
          void viewSession(origin.sourceSessionId, origin.sourceName);
        }}
        pendingUserMessage={pendingUserMessage}
        localFailures={withoutPersistedFailure(
          localFailures.filter((entry: any) =>
            entry.sessionId === (localDraft ? DRAFT_FAILURE_SCOPE : viewedSessionId),
          ),
          messages,
        )}
        liveMessage={liveMessage}
        localDraft={localDraft}
        composerHasContent={composerHasContent}
        suppressNewWelcome={lifecycleBlocked}
        newConversationPresentation={newConversationPresentation}
        firstRunGuide={newConversationPresentation && sessionsTotal === 0 ? {
          runtimeStatus: primaryRuntime.status,
          ...(piVersion ? { piVersion } : null),
        } : undefined}
        waitingForPiMessage={waitingForPiMessage}
        draftWorkspaceCwd={draftWorkspaceCwd}
        workspaceCwd={conversationWorkspace}
        openLinkedWorkspaceFile={api.openLinkedWorkspaceFile}
        workspacePicking={workspacePicking}
        draftWorkspaceOptions={draftWorkspaceOptions}
        onSelectDraftWorkspace={selectDraftWorkspace}
        onPickDraftWorkspace={() => void pickDraftWorkspace()}
        messagesTruncated={messagesTruncated}
        visibleTurnCount={visibleTurnCount}
        turnTotal={turnTotal}
        messageTotal={messageTotal}
        runStartedAt={runStartedAt}
        lastRunDurationMs={lastRunDurationMs}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={() => void loadEarlierTurns()}
        state={state}
        toolStatus={toolStatus}
        onForkUserMessage={(message: any) => {
          if (!viewedSession || !message.piChatPersistedMessageId) return;
          const text = forkableUserMessageText(message);
          const imageCount = Array.isArray(message.content)
            ? message.content.filter((block: any) => block.type === "image").length
            : 0;
          if (!text && imageCount === 0) return;
          setSessionDialog({
            mode: "fork",
            session: viewedSession,
            persistedMessageId: message.piChatPersistedMessageId,
            messagePreview: forkMessagePreview(text, imageCount),
          });
        }}
        forkUserMessageDisabled={Boolean(
          !viewedSession ||
          localDraft ||
          viewingSubagentSession ||
          mutationBlocked ||
          state.isStreaming ||
          state.isCompacting ||
          displayedQueue.length > 0 ||
          queuePaused ||
          extensionRequest ||
          copyingSessionIds.includes(viewedSessionId),
        )}
        onNavigate={navigateConversation}
        sessionControl={{
          observing: viewingSubagentSession ? false : observing,
        }}
        promptQueue={{
          queue: displayedQueue,
          paused: queuePaused,
          busy:
            currentSessionBusyBeforeStreaming ||
            viewSwitching ||
            mutationBlocked ||
            viewingSubagentSession,
          onCancel: cancelQueuedPrompt,
          onResume: resumeQueuedPrompt,
        }}
        pendingSteers={{
          items: pendingSteersBySession[viewedSessionId] || [],
          dequeueing: steerDequeueingBySession[viewedSessionId] === true,
          onDequeue: dequeuePendingSteers,
        }}
        chatInput={{
          streaming: viewingSubagentSession ? false : composerQueueMode,
          activelyStreaming: viewingSubagentSession ? false : state.isStreaming,
          stopping: viewingSubagentSession ? false : stoppingCurrentSession,
          // Editing is independent from runtime preparation, compaction, and
          // foreign control. Only the initial unaddressed pane is blocked so
          // bootstrap cannot replace a provisional `session:none` draft.
          disabled: mutationBlocked || initialPaneUnresolved,
          disabledPlaceholder: buildIdentityMismatch
            ? "网页与服务构建不一致；请刷新页面后再提交操作"
            : lifecycleBlocked
              ? "Pi Chat 正在执行全局维护，暂时不能提交新操作"
              : initialPaneUnresolved
                ? "正在恢复已保存的对话，请稍候…"
                : undefined,
          acceptsImages:
            !viewingSubagentSession &&
            composerState.model?.input?.includes("image") === true,
          imageInputPending:
            !viewingSubagentSession && primaryCapabilityPending,
          restoredDraft: restoredComposerDrafts[composerDraftKeyId(composerDraftKey)] || null,
          onDraftRevisionChange: (key: any, revision: any, hasContent: any) => {
            const keyId = composerDraftKeyId(key);
            composerDraftRevisionsRef.current.set(keyId, revision);
            setComposerContentByScope((current: any) =>
              current[keyId] === hasContent
                ? current
                : { ...current, [keyId]: hasContent },
            );
          },
          draftKey: composerDraftKey,
          forgottenComposerKeys,
          submissionScope: composerSubmissionScope,
          submissionTargetSessionId: composerTargetSessionId || undefined,
          allowFollowupSubmissions: true,
          submissionPaused: composerSubmissionPaused,
          onSubmissionPendingChange: updateComposerPending,
          commands: composerCommands,
          controls: composerControls,
          notices: composerNotices,
          onSend: async (message: any, images: any, delivery: any, snapshotTargetSessionId: any) => {
            const targetSessionId = snapshotTargetSessionId || "";
            if (
              viewingSubagentSession &&
              (!targetSessionId ||
                delivery !== "queue" ||
                message.startsWith("/"))
            )
              throw new Error("子代理视图仅支持向已验证父对话发送普通消息");
            return send(message, images, delivery, targetSessionId);
          },
          onPickLocalFiles: async () => (await api.pickLocalFiles()).paths,
          onReadClipboardFiles: async (files: any) => (await api.clipboardLocalFiles(files)).paths,
          onError: setError,
          onAbort: stopGeneration,
        }}
      />
      {managementSection && <Suspense fallback={null}>
      <ManagementPanel
        section={managementSection}
        appearance={appearance}
        workspaceCwd={workspaceCwd}
        workspacePicking={workspacePicking}
        workspaceDisabled={mutationBlocked}
        models={models}
        modelRuntimeSyncPending={modelRuntimeSyncPending}
        state={state}
        busy={busy || globalMutationBlocked}
        shutdownBlocked={
          busy ||
          (buildIdentityMismatch
            ? recoveryActionBlocked
            : globalMutationBlocked)
        }
        diagnosticsBusy={diagnosticsBusy}
        buildIdentity={serverBuildIdentity}
        webBuildIdentity={webBuildIdentity}
        piVersion={piVersion}
        primaryRuntime={primaryRuntime}
        onClose={() => setManagementSection(null)}
        onAppearance={setAppearance}
        onPickWorkspace={() => void pickDefaultWorkspace()}
        onModel={(provider: any, id: any, api: any) => void changeModel(provider, id, api)}
        onModelsChanged={(data: any) => {
          if (
            modelCatalogueRevisionGate.admitBootstrap(
              data.modelCatalogueRevision,
            )
          ) {
            setModels(data.models);
            setModelRuntimeSyncPending(data.modelRuntimeSyncPending === true);
            saveModelCatalog(data.models);
          }
          dispatchPane({ type: "RUNTIME_SETTINGS_ADOPTED", target: localDraftRef.current ? { kind: "draft" } : { kind: "session", sessionId: viewedSessionIdRef.current }, state: { model: data.state.model } });
        }}
        onRuntimeSetup={openRuntimeSetup}
        onExportDiagnostics={exportStateDiagnostics}
        onShutdown={() => void shutdownPiChat()}
      />
      </Suspense>}
      {runtimeSetupDialog}
      <SessionDialog
        state={sessionDialog}
        busy={sessionActionBusy}
        disabled={buildIdentityMismatch || sessionDialogCopyBlocked}
        onClose={() => setSessionDialog(null)}
        onRename={(name: any) => void renameSession(name)}
        onClone={() => confirmCloneSession()}
        onFork={() => confirmForkSession()}
        onDelete={() => void deleteSession()}
      />
      {!viewingSubagentSession && Object.entries(askQuestionnaires).map(([askSessionId, questionnaire]: any) => (
        <AskQuestionnaireDialog
          key={`${askSessionId}:${questionnaire.toolCallId}`}
          plan={questionnaire}
          request={askSessionId === viewedSessionId ? extensionRequest : null}
          visible={askSessionId === viewedSessionId}
          disabled={buildIdentityMismatch}
          onRespond={respondToExtension}
          onFallback={() => dispatchAskQuestionnaire({
            type: "CLOSE_IF_MATCH",
            sessionId: askSessionId,
            toolCallId: questionnaire.toolCallId,
          })}
        />
      ))}
      {!viewingSubagentSession && !askQuestionnaires[viewedSessionId] && (
        <ExtensionDialog
          request={extensionRequest}
          sessionId={viewedSessionId}
          continuationPending={toolStatus === "正在运行工具：ask_user_question"}
          disabled={buildIdentityMismatch}
          onRespond={(body: any) => void respondToExtension(body)}
        />
      )}
      <Suspense fallback={null}>
      <EditDiffSidebar
        open={diffSidebarOpen}
        width={diffSidebarWidth}
        sessionId={inspectorSessionId}
        workspacePath={conversationWorkspace}
        workspaceActivityRevision={workspaceActivityRevision}
        listWorkspaceFiles={api.workspaceFiles}
        readWorkspaceFile={api.workspaceFile}
        openWorkspaceFile={api.openWorkspaceFile}
        onOpenChange={setDiffSidebarOpen}
        onWidthChange={setDiffSidebarWidth}
      />
      </Suspense>
    </AppShell>
  );
}
