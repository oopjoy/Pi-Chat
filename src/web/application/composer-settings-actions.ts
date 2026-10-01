import type { ExtensionUiRequest, GateMode, ModelInfo, ThinkingLevel } from "../../shared/types";
import type { SessionComposerSelection } from "../lib/session-composer-selection";

export function createComposerSettingsActions(host: Record<string, any>) {
  const {
    DRAFT_PREFS_KEY,
    api,
    buildIdentityMismatch,
    captureDraftPaneAuthority,
    capturePaneAuthority,
    commitDraftIfCurrent,
    commitPaneIfCurrent,
    dispatchPane,
    draftAuthorityCanCommit,
    draftWorkspacePickerTokenRef,
    extensionRequest,
    fetchSessionView,
    loadingEarlierRequestsRef,
    localDraftRef,
    modelSelectionPatch,
    models,
    mutationBlocked,
    navigationEpochRef,
    paneAuthorityCanCommit,
    pendingSessionPrefsRef,
    runEpochGenerationRef,
    runEpochRef,
    runtimeStatus,
    saveSessionComposerSelections,
    send,
    setComposerSelectionRevision,
    setError,
    setNotice,
    setWorkspaceCwd,
    setWorkspacePicking,
    stageGateMode,
    stageSessionComposerSelection,
    state,
    subagentAddressesRef,
    viewedSessionId,
    viewedSessionIdRef,
    workspaceDefaultPickerTokenRef,
    workspaceEpochRef,
    workspacePicking,
    workspaceRevisionRef,
  } = host;
  const composerTargetForViewedSession = () => {
    // Background-child records are never normal Runtime targets. Follow only
    // server-derived direct-parent edges until reaching the verified ordinary
    // ancestor; malformed/cyclic retained addresses fail closed.
    let target = viewedSessionIdRef.current;
    const visited = new Set<string>();
    while (target && subagentAddressesRef.current.has(target)) {
      if (visited.has(target)) return "";
      visited.add(target);
      const parentSessionId = subagentAddressesRef.current.get(target)?.parentSessionId;
      if (!parentSessionId || visited.has(parentSessionId)) return "";
      target = parentSessionId;
    }
    return target;
  };

  const stageComposerSelection = (
    key: string,
    patch: Pick<SessionComposerSelection, "model" | "thinkingLevel">,
  ) => {
    if (!key) return undefined;
    const next = stageSessionComposerSelection(
      pendingSessionPrefsRef.current.get(key),
      patch,
    );
    pendingSessionPrefsRef.current.set(key, next);
    // Persist the click synchronously as browser-local intent so an immediate
    // F5 cannot race React's post-commit storage effect.
    saveSessionComposerSelections(pendingSessionPrefsRef.current);
    // This value is only a render invalidator. The selection itself remains
    // session-keyed in the ref so navigation never aliases one target's choice
    // onto another target's Composer.
    setComposerSelectionRevision((revision: any) => revision + 1);
    return next;
  };

  const stageSessionPref = (patch: Pick<
    SessionComposerSelection,
    "model" | "thinkingLevel"
  >) => {
    const key = localDraftRef.current
      ? DRAFT_PREFS_KEY
      : composerTargetForViewedSession();
    return stageComposerSelection(key, patch);
  };

  const changeModel = (provider: string, modelId: string, modelApi?: string) => {
    if (buildIdentityMismatch || !provider || !modelId) return;
    const model = models.find(
      (candidate: any) =>
        candidate.provider === provider && candidate.id === modelId
        && (modelApi ? candidate.api === modelApi : true),
    );
    const viewed = viewedSessionIdRef.current;
    const targetSessionId = composerTargetForViewedSession();
    const childOriginated = Boolean(
      viewed && targetSessionId && viewed !== targetSessionId,
    );
    // A child transcript is read-only. Do not let its controls mutate the
    // verified ordinary parent selection, even through a programmatic call.
    if (childOriginated) {
      setNotice("子代理对话为只读，不能修改模型设置");
      return;
    }
    if (!model) return;
    const selectionKey = localDraftRef.current
      ? DRAFT_PREFS_KEY
      : targetSessionId;
    stageComposerSelection(
      selectionKey,
      modelSelectionPatch(
        state,
        pendingSessionPrefsRef.current.get(selectionKey),
        model,
        models,
      ),
    );
    setError("");
  };

  const changeThinking = (level: ThinkingLevel) => {
    if (buildIdentityMismatch) return;
    const viewed = viewedSessionIdRef.current;
    const targetSessionId = composerTargetForViewedSession();
    const childOriginated = Boolean(
      viewed && targetSessionId && viewed !== targetSessionId,
    );
    // A child transcript is read-only. Do not let its controls mutate the
    // verified ordinary parent selection, even through a programmatic call.
    if (childOriginated) {
      setNotice("子代理对话为只读，不能修改思考强度");
      return;
    }
    stageSessionPref({ thinkingLevel: level });
    setError("");
  };

  const selectDraftWorkspace = (cwd: string) => {
    const selected = cwd.trim();
    if (workspacePicking || !localDraftRef.current || !selected) return;
    const authority = captureDraftPaneAuthority();
    setError("");
    commitDraftIfCurrent(authority, {
      type: "DRAFT_WORKSPACE_SELECTED",
      cwd: selected,
    });
    setNotice(`新对话将使用工作目录：${selected}`);
  };

  const pickDraftWorkspace = async () => {
    if (workspacePicking || !localDraftRef.current) return;
    const authority = captureDraftPaneAuthority();
    const token = Symbol("draft-workspace-picker");
    draftWorkspacePickerTokenRef.current = token;
    setWorkspacePicking(true);
    setError("");
    setNotice("请在弹出的 Windows 窗口中浏览并选择新对话工作目录");
    try {
      const result = await api.pickDraftWorkspace();
      if (
        draftWorkspacePickerTokenRef.current !== token ||
        !draftAuthorityCanCommit(authority) ||
        result.cancelled ||
        !result.cwd
      )
        return;
      commitDraftIfCurrent(authority, {
        type: "DRAFT_WORKSPACE_SELECTED",
        cwd: result.cwd,
      });
      setNotice(`新对话将使用工作目录：${result.cwd}`);
    } catch (cause) {
      if (
        draftWorkspacePickerTokenRef.current === token &&
        draftAuthorityCanCommit(authority)
      )
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (draftWorkspacePickerTokenRef.current === token) {
        draftWorkspacePickerTokenRef.current = null;
        setWorkspacePicking(false);
      }
    }
  };

  const pickDefaultWorkspace = async () => {
    if (workspacePicking || mutationBlocked) return;
    const runEpochGeneration = runEpochGenerationRef.current;
    const token = Symbol("default-workspace-picker");
    workspaceDefaultPickerTokenRef.current = token;
    setWorkspacePicking(true);
    setError("");
    setNotice("请在弹出的 Windows 窗口中选择默认工作路径");
    try {
      const result = await api.pickWorkspace();
      if (
        workspaceDefaultPickerTokenRef.current !== token ||
        runEpochGenerationRef.current !== runEpochGeneration ||
        result.cancelled ||
        !result.cwd
      )
        return;
      // This is global metadata only. A pending draft can have its own selected
      // cwd, and an existing Runtime always keeps its immutable Session cwd.
      const workspaceEpoch =
        typeof result.workspaceEpoch === "string"
          ? result.workspaceEpoch
          : runEpochRef.current;
      const workspaceRevision =
        typeof result.workspaceRevision === "number" &&
        Number.isFinite(result.workspaceRevision)
          ? result.workspaceRevision
          : workspaceRevisionRef.current + 1;
      if (
        (!workspaceEpochRef.current ||
          workspaceEpoch === workspaceEpochRef.current) &&
        workspaceRevision >= workspaceRevisionRef.current
      ) {
        workspaceEpochRef.current = workspaceEpoch || workspaceEpochRef.current;
        workspaceRevisionRef.current = workspaceRevision;
        setWorkspaceCwd(result.cwd);
      }
      setNotice(`以后新建的对话将使用工作目录：${result.cwd}`);
    } catch (cause) {
      if (workspaceDefaultPickerTokenRef.current === token)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (workspaceDefaultPickerTokenRef.current === token) {
        workspaceDefaultPickerTokenRef.current = null;
        setWorkspacePicking(false);
      }
    }
  };

  const changeGate = async (mode: GateMode) => {
    const viewed = viewedSessionIdRef.current;
    const sessionId = composerTargetForViewedSession();
    if (buildIdentityMismatch) return;
    // A local New draft has no Runtime yet. Stage only its desired first-turn
    // Gate value; the initial-submit FIFO applies it before the user prompt.
    if (localDraftRef.current) {
      stageGateMode(DRAFT_PREFS_KEY, mode);
      setNotice(`已选择 ${mode === "open" ? "放行" : "严格"}，发送时生效`);
      return;
    }
    if (!sessionId) return;
    const childOriginated = Boolean(viewed && viewed !== sessionId);
    // A child transcript is read-only. A child-originated Gate choice must
    // never be staged as a parent preference; reject it explicitly instead.
    if (childOriginated) {
      setNotice("子代理对话为只读，不能修改文件权限模式");
      return;
    }
    // A cold history pane and local preparation stage Gate for the target
    // prompt instead of issuing an unauthorized command against a Runtime the
    // pane does not own. Staging is local and never blocked by an in-flight
    // settings request.
    if (runtimeStatus !== "active" || state.isCompacting) {
      stageGateMode(sessionId, mode);
      setNotice(`已选择 ${mode === "open" ? "放行" : "严格"}，发送时生效`);
      return;
    }
    // An explicit active-Runtime choice supersedes any cold staged intent. Do
    // this before issuing /gate so an older staged value cannot later override
    // a confirmed opposite command in UI, prompt payload, or auto-allow logic.
    stageGateMode(sessionId, undefined);
    // An active Runtime still requires its own confirmation before browser UI
    // may change a security-sensitive Gate setting.
    await send(`/gate ${mode}`, []);
  };

  const respondToExtension = async (body: {
    id?: string;
    cancelled?: boolean;
    confirmed?: boolean;
    value?: string;
  }): Promise<boolean> => {
    if (buildIdentityMismatch) return false;
    const submittedRequest = extensionRequest;
    if (!submittedRequest) return false;
    const sessionId =
      submittedRequest.piChatSessionId || viewedSessionIdRef.current;
    if (!sessionId) {
      setError("确认请求缺少会话标识，已拒绝发送");
      return false;
    }
    if (subagentAddressesRef.current.has(sessionId)) {
      setError("子代理对话为只读，不能提交扩展或问卷确认");
      return false;
    }
    const retryRequest = (candidate: ExtensionUiRequest | null | undefined) => {
      if (
        candidate &&
        (candidate.method === "input" || candidate.method === "editor") &&
        typeof body.value === "string"
      ) return { ...candidate, prefill: body.value };
      return candidate || null;
    };
    // A response failure can arrive after A → B → A. Keep its recovery bound
    // to the exact pane that submitted the confirmation, not just its ID.
    const extensionAuthority = capturePaneAuthority(sessionId);
    dispatchPane({
      type: "EXTENSION_REQUEST_CHANGED",
      sessionId,
      request: null,
    });
    try {
      await api.respondToExtension({
        ...body,
        id: submittedRequest.id,
        sessionId,
      });
      return true;
    } catch (cause) {
      let acceptedDespiteFailure = false;
      // Re-read the authoritative pending request. This distinguishes a real
      // delivery failure from a lost HTTP response after Pi already accepted it.
      try {
        const view = await fetchSessionView(sessionId);
        acceptedDespiteFailure =
          !view.pendingExtensionRequest ||
          view.pendingExtensionRequest.id !== submittedRequest.id;
        commitPaneIfCurrent(extensionAuthority, {
          type: "EXTENSION_REQUEST_CHANGED",
          sessionId,
          request: retryRequest(view.pendingExtensionRequest),
        });
      } catch {
        commitPaneIfCurrent(extensionAuthority, {
          type: "EXTENSION_REQUEST_CHANGED",
          sessionId,
          request: retryRequest(submittedRequest),
        });
      }
      if (paneAuthorityCanCommit(extensionAuthority))
        setError(cause instanceof Error ? cause.message : String(cause));
      return acceptedDespiteFailure;
    }
  };

  const loadingEarlier =
    loadingEarlierRequestsRef.current.get(viewedSessionId)?.navigationEpoch ===
    navigationEpochRef.current;

  return {
    composerTargetForViewedSession,
    stageComposerSelection,
    stageSessionPref,
    changeModel,
    changeThinking,
    selectDraftWorkspace,
    pickDraftWorkspace,
    pickDefaultWorkspace,
    changeGate,
    respondToExtension,
    loadingEarlier,
  };
}
