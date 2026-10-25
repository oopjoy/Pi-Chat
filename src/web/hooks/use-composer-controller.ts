import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { PromptDelivery, PromptImage } from "../../shared/types";
import {
  composerAcceptError,
  composePromptWithAttachedFiles,
  composerDraftKeyId,
  composerPartition,
  composerPendingUsage,
  composerReducer,
  draftFiles,
  emptyComposerState,
  type ComposerAction,
  type ComposerDraftKey,
  type ComposerSnapshot,
  type ComposerState,
} from "../state/composer";

import { attachmentStorageOwner, composerFileReferences } from "../lib/attachment-owner";

export type ComposerRestoredDraft = {
  key: ComposerDraftKey;
  revision: number;
  expectedDraftRevision: number;
  message: string;
  images: PromptImage[];
  files?: string[];
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
  prepareLocalFiles?: (paths: string[]) => Promise<void>;
  updateAttachmentLeases?: (paths: string[], active: boolean, owner: string) => Promise<void>;
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
  prepareLocalFiles,
  updateAttachmentLeases,
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
  const prepareRef = useRef(prepareLocalFiles);
  const leaseRef = useRef(updateAttachmentLeases);
  prepareRef.current = prepareLocalFiles;
  leaseRef.current = updateAttachmentLeases;
  const [leaseWarning, setLeaseWarning] = useState("");
  const leasePathsRef = useRef<string[]>([]);
  const leaseRunningRef = useRef(false);
  const leaseDirtyRef = useRef(false);
  const leaseKnownPathsRef = useRef(new Set<string>());
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

  const syncLeases = useCallback(function syncAttachmentLeases(next: ComposerState, renew = false): void {
    const paths = composerFileReferences(next).sort();
    const previous = leasePathsRef.current;
    if (!renew && !leaseDirtyRef.current && JSON.stringify(previous) === JSON.stringify(paths)) return;
    leasePathsRef.current = paths;
    for (const path of paths) leaseKnownPathsRef.current.add(path);
    leaseDirtyRef.current = true;
    if (leaseRunningRef.current) return; // coalesce slow/offline heartbeats, never build an unbounded tail
    const owner = attachmentStorageOwner();
    let failed = false;
    leaseRunningRef.current = true;
    void (async () => {
      while (leaseDirtyRef.current) {
        leaseDirtyRef.current = false;
        const desired = [...leasePathsRef.current];
        // Claim before release; re-read desired paths after an awaited claim.
        if (desired.length) await leaseRef.current?.(desired, true, owner);
        const removed = [...leaseKnownPathsRef.current].filter((path) => !leasePathsRef.current.includes(path));
        if (removed.length) await leaseRef.current?.(removed, false, owner);
        for (const path of removed) {
          if (!leasePathsRef.current.includes(path)) leaseKnownPathsRef.current.delete(path);
          else leaseDirtyRef.current = true;
        }
      }
      if (mountedRef.current) setLeaseWarning("");
    })().catch(() => {
      failed = true;
      leaseDirtyRef.current = true; // retry on edit/online/heartbeat, never in a tight failure loop
      if (mountedRef.current) setLeaseWarning("附件草稿保留状态未能更新，请在服务恢复后重试；不要假定附件已永久保存。");
    }).finally(() => {
      leaseRunningRef.current = false;
      if (!failed && leaseDirtyRef.current && mountedRef.current)
        syncAttachmentLeases(stateRef.current);
    });
  }, []);

  useEffect(() => {
    // Attachment leases outlive a page, but unsent text/images do not. Renew
    // only server file references; never read or recreate browser draft backups.
    const renew = () => syncLeases(stateRef.current, true);
    const visible = () => { if (document.visibilityState === "visible") renew(); };
    const timer = window.setInterval(renew, 60_000);
    window.addEventListener("online", renew);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", renew);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [syncLeases]);

  const publish = useCallback((next: ComposerState, key: ComposerDraftKey) => {
    const partition = composerPartition(next, key);
    onRevisionRef.current?.(
      key,
      partition.draft.revision,
      Boolean(partition.draft.message.trim() || partition.draft.images.length || draftFiles(partition.draft).length),
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
    syncLeases(next);
    return next;
  }, [publish, syncLeases]);

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
    void (async () => {
      // This acknowledgement must precede every path that can submit to Pi.
      // A failed retention request is a definite local preflight rejection.
      if (draftFiles(snapshot).length) await prepareRef.current?.(draftFiles(snapshot));
      await onSendRef.current(
        composePromptWithAttachedFiles(snapshot.message, draftFiles(snapshot)),
        snapshot.images, snapshot.delivery, snapshot.targetSessionId,
      );
    })()
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
      files: restoredDraft.files,
      prepend: restoredDraft.prepend,
    });
  }, [commit, draftKey, restoredDraft]);

  const partition = composerPartition(state, draftKey);
  const edit = useCallback((message: string) => {
    commit({ type: "edit", key: keyRef.current, message });
  }, [commit]);
  const replace = useCallback((message: string, images: PromptImage[], files?: string[]) => {
    commit({ type: "replace", key: keyRef.current, message, images, ...(files ? { files } : null) });
  }, [commit]);
  const clear = useCallback(() => {
    commit({ type: "clear", key: keyRef.current });
  }, [commit]);
  const recoverSuspended = useCallback(() => {
    commit({ type: "recover-suspended", key: keyRef.current });
  }, [commit]);
  const currentDraft = useCallback(() =>
    composerPartition(stateRef.current, keyRef.current).draft, []);
  const hasUnsentContent = useCallback(() => composerPendingUsage(stateRef.current).payloadBytes > 0, []);
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
      files: [...draftFiles(current.draft)],
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
    retainedDraftCount: partition.suspended?.length || 0,
    recoverSuspended,
    edit,
    replace,
    clear,
    currentDraft,
    hasUnsentContent,
    attachmentOwner: () => attachmentStorageOwner(),
    submit,
    storageWarning: leaseWarning,
  };
}
