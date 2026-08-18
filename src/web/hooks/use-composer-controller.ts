import { useCallback, useEffect, useReducer, useRef } from "react";
import type { PromptDelivery, PromptImage } from "../../shared/types";
import {
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
};

type ComposerControllerOptions = {
  draftKey: ComposerDraftKey;
  targetSessionId?: string;
  disabled: boolean;
  paused: boolean;
  allowFollowupSubmissions: boolean;
  restoredDraft?: ComposerRestoredDraft | null;
  onDraftRevisionChange?: (key: ComposerDraftKey, revision: number) => void;
  onSubmissionPendingChange?: (scope: string, count: number) => void;
  onSend: (message: string, images: PromptImage[], delivery?: PromptDelivery, targetSessionId?: string) => Promise<void>;
};

/**
 * Runs editor-owned snapshots while keeping all transport authority in App.
 * A rejection is definite because App resolves written-outcome-unknown calls;
 * therefore only rejected promises restore a draft for retry.
 */
export function useComposerController({
  draftKey,
  targetSessionId,
  disabled,
  paused,
  allowFollowupSubmissions,
  restoredDraft,
  onDraftRevisionChange,
  onSubmissionPendingChange,
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
  const drainingRef = useRef(false);
  const mountedRef = useRef(true);
  const appliedRestorationsRef = useRef(new Set<string>());
  keyRef.current = draftKey;
  disabledRef.current = disabled;
  pausedRef.current = paused;
  onSendRef.current = onSend;
  onRevisionRef.current = onDraftRevisionChange;
  onPendingRef.current = onSubmissionPendingChange;

  const publish = useCallback((next: ComposerState, key: ComposerDraftKey) => {
    const partition = composerPartition(next, key);
    onRevisionRef.current?.(key, partition.draft.revision);
    onPendingRef.current?.(
      composerDraftKeyId(key),
      partition.pending.length + (partition.inFlight ? 1 : 0),
    );
  }, []);

  const commit = useCallback((action: ComposerAction) => {
    const next = composerReducer(stateRef.current, action);
    stateRef.current = next;
    dispatch(action);
    const key = action.type === "accept" ? action.snapshot.key : action.key;
    publish(next, key);
    return next;
  }, [publish]);

  const drain = useCallback(function drainActivePartition(): void {
    if (drainingRef.current || disabledRef.current || pausedRef.current) return;
    const key = keyRef.current;
    const partition = composerPartition(stateRef.current, key);
    if (partition.blocked || partition.inFlight || !partition.pending.length) return;
    const next = commit({ type: "start-delivery", key });
    const snapshot = composerPartition(next, key).inFlight;
    if (!snapshot) return;
    drainingRef.current = true;
    void onSendRef.current(
      snapshot.message,
      snapshot.images,
      snapshot.delivery,
      snapshot.targetSessionId,
    )
      .then(() => commit({ type: "delivery-accepted", key: snapshot.key }))
      .catch(() => commit({ type: "delivery-rejected", key: snapshot.key }))
      .finally(() => {
        drainingRef.current = false;
        if (mountedRef.current) drainActivePartition();
      });
  }, [commit]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => { drain(); }, [draftKey, disabled, paused, drain]);

  useEffect(() => {
    if (!restoredDraft || composerDraftKeyId(restoredDraft.key) !== composerDraftKeyId(draftKey)) return;
    const token = `${composerDraftKeyId(restoredDraft.key)}:${restoredDraft.revision}`;
    if (appliedRestorationsRef.current.has(token)) return;
    const partition = composerPartition(stateRef.current, draftKey);
    if (partition.draft.revision !== restoredDraft.expectedDraftRevision) return;
    appliedRestorationsRef.current.add(token);
    commit({
      type: "restore-cancelled",
      key: draftKey,
      expectedRevision: restoredDraft.expectedDraftRevision,
      message: restoredDraft.message,
      images: restoredDraft.images,
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
    commit({ type: "accept", snapshot, retry: Boolean(current.blocked) });
    drain();
    return true;
  }, [allowFollowupSubmissions, commit, drain, targetSessionId]);

  return {
    draft: partition.draft,
    blocked: Boolean(partition.blocked),
    pendingCount: partition.pending.length + (partition.inFlight ? 1 : 0),
    edit,
    replace,
    clear,
    currentDraft,
    submit,
  };
}
