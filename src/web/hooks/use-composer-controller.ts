import { useCallback, useEffect, useReducer, useRef } from "react";
import type { PromptDelivery, PromptImage } from "../../shared/types";
import {
  composerAcceptError,
  composerDraftKeyId,
  composerPartition,
  composerReducer,
  emptyComposerState,
  type ComposerAction,
  type ComposerDraftKey,
  type ComposerSnapshot,
  type ComposerState,
} from "../state/composer";

export type ComposerRestoredDraft = {
  key: ComposerDraftKey;
  revision: number;
  expectedDraftRevision: number;
  message: string;
  images: PromptImage[];
  prepend?: boolean;
};

type ComposerControllerOptions = {
  draftKey: ComposerDraftKey;
  /** Stable IDs whose Composer partitions were structurally deleted. */
  forgottenKeys?: string[];
  targetSessionId?: string;
  disabled: boolean;
  paused: boolean;
  allowFollowupSubmissions: boolean;
  restoredDraft?: ComposerRestoredDraft | null;
  onDraftRevisionChange?: (key: ComposerDraftKey, revision: number, hasContent: boolean) => void;
  onSubmissionPendingChange?: (scope: string, count: number) => void;
  onError?: (message: string) => void;
  onSend: (message: string, images: PromptImage[], delivery?: PromptDelivery, targetSessionId?: string) => Promise<void>;
};

/**
 * Runs editor-owned snapshots while keeping all transport authority in App.
 * A rejection is definite because App resolves written-outcome-unknown calls;
 * therefore only rejected promises restore a draft for retry.
 */
function composerKeyFromId(keyId: string): ComposerDraftKey | null {
  if (keyId.startsWith("session:")) {
    const sessionId = keyId.slice("session:".length);
    return sessionId ? { kind: "session", sessionId } : null;
  }
  if (keyId.startsWith("draft:")) {
    const generation = Number(keyId.slice("draft:".length));
    return Number.isSafeInteger(generation) && generation >= 0
      ? { kind: "new", generation }
      : null;
  }
  return null;
}

export function useComposerController({
  draftKey,
  forgottenKeys = [],
  targetSessionId,
  disabled,
  paused,
  allowFollowupSubmissions,
  restoredDraft,
  onDraftRevisionChange,
  onSubmissionPendingChange,
  onError,
  onSend,
}: ComposerControllerOptions) {
  const [state, dispatch] = useReducer(composerReducer, undefined, emptyComposerState);
  const stateRef = useRef<ComposerState>(state);
  const keyRef = useRef(draftKey);
  const disabledRef = useRef(disabled);
  const pausedRef = useRef(paused);
  const onSendRef = useRef(onSend);
  const onRevisionRef = useRef(onDraftRevisionChange);
  const onPendingRef = useRef(onSubmissionPendingChange);
  const onErrorRef = useRef(onError);
  // Delivery is serialized per draft target, not per mounted Composer. A long
  // preparation/Prompt request for Session A must never block a newly accepted
  // snapshot for Session B after navigation.
  const drainingKeysRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const appliedRestorationsRef = useRef(new Set<string>());
  const forgottenKeysRef = useRef(new Set<string>());
  keyRef.current = draftKey;
  disabledRef.current = disabled;
  pausedRef.current = paused;
  onSendRef.current = onSend;
  onRevisionRef.current = onDraftRevisionChange;
  onPendingRef.current = onSubmissionPendingChange;
  onErrorRef.current = onError;

  const publish = useCallback((next: ComposerState, key: ComposerDraftKey) => {
    const partition = composerPartition(next, key);
    onRevisionRef.current?.(
      key,
      partition.draft.revision,
      Boolean(partition.draft.message.trim() || partition.draft.images.length),
    );
    onPendingRef.current?.(
      composerDraftKeyId(key),
      partition.pending.length + (partition.inFlight ? 1 : 0),
    );
  }, []);

  const commit = useCallback((action: ComposerAction) => {
    const actionKey = action.type === "accept" ? action.snapshot.key : action.key;
    const actionKeyId = composerDraftKeyId(actionKey);
    if (action.type !== "forget" && forgottenKeysRef.current.has(actionKeyId))
      return stateRef.current;
    const next = composerReducer(stateRef.current, action);
    stateRef.current = next;
    dispatch(action);
    const key = action.type === "accept" ? action.snapshot.key : action.key;
    publish(next, key);
    return next;
  }, [publish]);

  const drain = useCallback(function drainActivePartition(): void {
    if (disabledRef.current || pausedRef.current) return;
    const key = keyRef.current;
    const keyId = composerDraftKeyId(key);
    if (drainingKeysRef.current.has(keyId) || forgottenKeysRef.current.has(keyId)) return;
    const partition = composerPartition(stateRef.current, key);
    if (partition.blocked || partition.inFlight || !partition.pending.length) return;
    const next = commit({ type: "start-delivery", key });
    const snapshot = composerPartition(next, key).inFlight;
    if (!snapshot) return;
    drainingKeysRef.current.add(keyId);
    void onSendRef.current(
      snapshot.message,
      snapshot.images,
      snapshot.delivery,
      snapshot.targetSessionId,
    )
      .then(() => commit({ type: "delivery-accepted", key: snapshot.key }))
      .catch((error) => commit({
        type: "delivery-rejected",
        key: snapshot.key,
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        drainingKeysRef.current.delete(keyId);
        // Only the currently painted partition is eligible for this hook's
        // disabled/paused guards. A later navigation effect will drain other
        // partitions without allowing them to share this lock.
        if (mountedRef.current && composerDraftKeyId(keyRef.current) === keyId)
          drainActivePartition();
      });
  }, [commit]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => { drain(); }, [draftKey, disabled, paused, drain]);

  useEffect(() => {
    for (const keyId of forgottenKeys) {
      if (forgottenKeysRef.current.has(keyId)) continue;
      forgottenKeysRef.current.add(keyId);
      drainingKeysRef.current.delete(keyId);
      const key = composerKeyFromId(keyId);
      if (key) commit({ type: "forget", key });
    }
  }, [commit, forgottenKeys]);

  useEffect(() => {
    if (!restoredDraft || composerDraftKeyId(restoredDraft.key) !== composerDraftKeyId(draftKey)) return;
    const token = `${composerDraftKeyId(restoredDraft.key)}:${restoredDraft.revision}`;
    if (appliedRestorationsRef.current.has(token)) return;
    const partition = composerPartition(stateRef.current, draftKey);
    if (
      !restoredDraft.prepend &&
      partition.draft.revision !== restoredDraft.expectedDraftRevision
    ) return;
    appliedRestorationsRef.current.add(token);
    commit({
      type: "restore-cancelled",
      key: draftKey,
      expectedRevision: restoredDraft.expectedDraftRevision,
      message: restoredDraft.message,
      images: restoredDraft.images,
      prepend: restoredDraft.prepend,
    });
  }, [commit, draftKey, restoredDraft]);

  const partition = composerPartition(state, draftKey);
  const edit = useCallback((message: string) => {
    commit({ type: "edit", key: keyRef.current, message });
  }, [commit]);
  const replace = useCallback((message: string, images: PromptImage[]) => {
    commit({ type: "replace", key: keyRef.current, message, images });
  }, [commit]);
  const clear = useCallback(() => {
    commit({ type: "clear", key: keyRef.current });
  }, [commit]);
  const currentDraft = useCallback(() =>
    composerPartition(stateRef.current, keyRef.current).draft, []);
  const submit = useCallback((delivery: PromptDelivery) => {
    const key = keyRef.current;
    const current = composerPartition(stateRef.current, key);
    if (!allowFollowupSubmissions && (current.pending.length || current.inFlight)) return false;
    const snapshot: ComposerSnapshot = {
      key,
      // Steer is meaningful only for the currently active Runtime. Normal
      // queued prompts capture their immutable ordinary target for navigation.
      ...(targetSessionId && delivery !== "steer" ? { targetSessionId } : null),
      message: current.draft.message,
      images: [...current.draft.images],
      revision: current.draft.revision,
      delivery,
    };
    const retry = Boolean(current.blocked);
    const budgetError = composerAcceptError(stateRef.current, snapshot, retry);
    if (budgetError) {
      onErrorRef.current?.(budgetError);
      return false;
    }
    commit({ type: "accept", snapshot, retry });
    drain();
    return true;
  }, [allowFollowupSubmissions, commit, drain, targetSessionId]);

  return {
    draft: partition.draft,
    blocked: Boolean(partition.blocked),
    blockedError: partition.blockedError,
    pendingCount: partition.pending.length + (partition.inFlight ? 1 : 0),
    edit,
    replace,
    clear,
    currentDraft,
    submit,
  };
}
