import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { PromptDelivery, PromptImage } from "../../shared/types";
import {
  composerAcceptError,
  composePromptWithAttachedFiles,
  composerDraftKeyId,
  composerPartition,
  composerReducer,
  draftFiles,
  emptyComposerState,
  composerPendingUsage,
  MAX_COMPOSER_PENDING_IMAGE_BYTES,
  MAX_COMPOSER_PENDING_PAYLOAD_BYTES,
  MAX_COMPOSER_PENDING_SNAPSHOTS,
  type ComposerAction,
  type ComposerDraftKey,
  type ComposerSnapshot,
  type ComposerState,
} from "../state/composer";

import { DraftRecoveryStore, DRAFT_RETENTION_MS, composerFileReferences, type RecoveryRecord } from "../lib/draft-recovery";

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
  validateRecoveredFiles?: (paths: string[], owner: string) => Promise<string[]>;
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
  validateRecoveredFiles,
}: ComposerControllerOptions) {
  const [state, dispatch] = useReducer(composerReducer, undefined, emptyComposerState);
  const stateRef = useRef<ComposerState>(state);
  const keyRef = useRef(draftKey);
  const recoveryKeyRef = useRef(composerDraftKeyId(draftKey));
  const recoveryEpochRef = useRef(0);
  if (recoveryKeyRef.current !== composerDraftKeyId(draftKey)) {
    recoveryKeyRef.current = composerDraftKeyId(draftKey);
    recoveryEpochRef.current += 1;
  }
  const disabledRef = useRef(disabled);
  const pausedRef = useRef(paused);
  const onSendRef = useRef(onSend);
  const onRevisionRef = useRef(onDraftRevisionChange);
  const onPendingRef = useRef(onSubmissionPendingChange);
  const onErrorRef = useRef(onError);
  const prepareRef = useRef(prepareLocalFiles);
  const leaseRef = useRef(updateAttachmentLeases);
  const validateRef = useRef(validateRecoveredFiles);
  prepareRef.current = prepareLocalFiles;
  leaseRef.current = updateAttachmentLeases;
  validateRef.current = validateRecoveredFiles;
  const [storageWarning, setStorageWarning] = useState("");
  const [leaseWarning, setLeaseWarning] = useState("");
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [recoveries, setRecoveries] = useState<RecoveryRecord[]>([]);
  const [recovering, setRecovering] = useState(false);
  const recoveryBusyRef = useRef(false);
  const storageRef = useRef<DraftRecoveryStore | null>(null);
  const leasePathsRef = useRef<string[]>([]);
  const recoveryLeasePathsRef = useRef(new Map<string, { paths: string[]; expiresAt: number }>());
  const leaseRunningRef = useRef(false);
  const leaseDirtyRef = useRef(false);
  const leaseKnownPathsRef = useRef(new Set<string>());
  const dismissedRecoveriesRef = useRef(new Set<string>());
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

  const storage = useCallback(() => {
    if (!storageRef.current) storageRef.current = new DraftRecoveryStore((message) => {
      if (mountedRef.current) setStorageWarning(message);
    });
    return storageRef.current;
  }, []);

  const syncLeases = useCallback(function syncAttachmentLeases(next: ComposerState, heartbeat = false): void {
    for (const [id, backup] of recoveryLeasePathsRef.current)
      if (backup.expiresAt <= Date.now()) recoveryLeasePathsRef.current.delete(id);
    const recoveryPaths = [...recoveryLeasePathsRef.current.values()].flatMap((backup) => backup.paths);
    const paths = [...new Set([...composerFileReferences(next), ...recoveryPaths])].sort();
    const previous = leasePathsRef.current;
    if (!heartbeat && JSON.stringify(previous) === JSON.stringify(paths)) return;
    leasePathsRef.current = paths;
    for (const path of paths) leaseKnownPathsRef.current.add(path);
    leaseDirtyRef.current = true;
    if (leaseRunningRef.current) return; // coalesce slow/offline heartbeats, never build an unbounded tail
    const owner = storage().owner;
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
      leaseDirtyRef.current = false; // the next heartbeat or edit can retry
      if (mountedRef.current) setLeaseWarning("附件草稿保留状态未能更新，请在服务恢复后重试；不要假定附件已永久保存。");
    }).finally(() => {
      leaseRunningRef.current = false;
      if (leaseDirtyRef.current) syncAttachmentLeases(stateRef.current, true);
    });
  }, [storage]);

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
    const passive = ["start-delivery", "delivery-accepted", "delivery-unknown", "delivery-rejected", "restore-cancelled"].includes(action.type);
    storage().persist(key, composerPartition(next, key), passive);
    syncLeases(next);
    return next;
  }, [publish, storage, syncLeases]);

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

  const recoveryPartitionId = composerDraftKeyId(draftKey);
  useEffect(() => {
    let current = true;
    const key = composerKeyFromId(recoveryPartitionId);
    if (!key) return;
    const existingPartition = Boolean(stateRef.current.partitions[recoveryPartitionId]);
    void storage().cleanup().then(() => storage().discover(key)).then((records) => {
      if (!current) return;
      const visible = records.filter((record) => (!existingPartition || record.owner !== storage().owner)
        && !dismissedRecoveriesRef.current.has(`${record.id}:${record.sequence}`));
      setRecoveries(visible);
      const paths = [...new Set(visible.flatMap((record) => record.frames.flatMap((frame) => frame.files)))];
      if (paths.length && paths.length <= 2048)
        void leaseRef.current?.(paths, true, "browser-backup").catch(() => {
          if (current) setLeaseWarning("备份中的部分附件未能续期；恢复时会重新核对，不会恢复成无效卡片。");
        });
    }).catch(() => { if (current) setStorageWarning("本地草稿备份暂时无法读取，请勿直接关闭尚未保存的输入。"); });
    const cleared = () => {
      recoveryLeasePathsRef.current.clear();
      syncLeases(stateRef.current);
      if (current) { setRecoveries([]); setStorageWarning(""); }
    };
    window.addEventListener("pi-chat-draft-storage-cleared", cleared);
    return () => { current = false; window.removeEventListener("pi-chat-draft-storage-cleared", cleared); };
  }, [recoveryPartitionId, storage, syncLeases]);

  useEffect(() => {
    const save = () => {
      for (const [id, partition] of Object.entries(stateRef.current.partitions)) {
        const key = composerKeyFromId(id);
        if (partition && key) storage().persist(key, partition, true);
      }
      syncLeases(stateRef.current, true);
    };
    const heartbeat = window.setInterval(save, 60_000);
    const hide = () => { if (document.visibilityState === "hidden") save(); };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [storage, syncLeases]);

  const restoreRecovery = async (record: RecoveryRecord, textOnly = false) => {
    if (recoveryBusyRef.current || disabledRef.current) return;
    recoveryBusyRef.current = true;
    const key = keyRef.current;
    const keyId = composerDraftKeyId(key);
    const epoch = recoveryEpochRef.current;
    setRecovering(true);
    try {
      const loaded = textOnly
        ? { drafts: record.frames.map((frame) => ({ message: frame.message, images: [], files: [], revision: 0,
            ...(frame.uncertain ? { recoveryWarning: "delivery-uncertain" as const } : {}) })), missingImages: [] }
        : await storage().load(record);
      const files = [...new Set(loaded.drafts.flatMap(draftFiles))];
      if (!textOnly && files.length) {
        const all = new Set([...recoveryLeasePathsRef.current.values()].flatMap((backup) => backup.paths));
        for (const path of files) all.add(path);
        if (all.size > 2048) throw new Error("待核对的附件备份过多，请先处理旧草稿");
        recoveryLeasePathsRef.current.set(record.id, { paths: files, expiresAt: record.updatedAt + DRAFT_RETENTION_MS });
        syncLeases(stateRef.current, true);
      }
      if (files.length && !validateRef.current) throw new Error("当前页面无法核对本地附件");
      const missing = files.length ? await validateRef.current!(files, storage().owner) : [];
      if (!await storage().isCurrent(record)) throw new Error("备份内容已经变化，请重新读取后再恢复");
      if (!mountedRef.current || disabledRef.current || recoveryEpochRef.current !== epoch
        || composerDraftKeyId(keyRef.current) !== keyId) return;
      const missingSet = new Set(missing);
      const backupLease = recoveryLeasePathsRef.current.get(record.id);
      if (backupLease) backupLease.paths = backupLease.paths.filter((path) => !missingSet.has(path));
      const drafts = loaded.drafts.map((draft) => ({ ...draft, files: draftFiles(draft).filter((path) => !missingSet.has(path)) }))
        .filter((draft) => draft.message || draft.images.length || draft.files.length);
      const absent = [...loaded.missingImages, ...missing];
      const absentDescription = absent.slice(0, 8).map((value) => {
        const name = value.replaceAll(String.fromCharCode(92), "/").split("/").at(-1) || value;
        return name.length > 160 ? `${name.slice(0, 80)}…${name.slice(-60)}` : name;
      }).join("、") + (absent.length > 8 ? `，另有 ${absent.length - 8} 个` : "");
      if (!drafts.length) {
        setRecoveryNotice(textOnly ? "这份备份没有可取回的文字；附件备份仍保留。"
          : `没有可恢复的有效内容；不可用的附件：${absentDescription}`);
        return;
      }
      const action: ComposerAction = { type: "recover-persisted", key, drafts };
      const candidate = composerReducer(stateRef.current, action);
      const usage = composerPendingUsage(candidate);
      if (usage.snapshots > MAX_COMPOSER_PENDING_SNAPSHOTS || usage.imageBytes > MAX_COMPOSER_PENDING_IMAGE_BYTES
        || usage.payloadBytes > MAX_COMPOSER_PENDING_PAYLOAD_BYTES) throw new Error("恢复后将超过编辑器容量限制，请先处理当前草稿。");
      commit(action);
      setRecoveryNotice(textOnly ? "仅取回了文字，未恢复附件；原备份未被移除，可稍后核对。"
        : absent.length ? `已恢复有效内容；未能恢复的附件：${absentDescription}。原备份仍保留，可稍后重试。`
          : "已恢复未发送草稿；没有自动发送任何消息。已有输入也会保留。");
      if (!textOnly && absent.length === 0) {
        recoveryLeasePathsRef.current.delete(record.id);
        storage().consume(record);
        dismissedRecoveriesRef.current.add(`${record.id}:${record.sequence}`);
        setRecoveries((records) => records.filter((item) => item.id !== record.id || item.sequence !== record.sequence));
      }
    } catch (error) {
      setRecoveryNotice(`恢复未完成：${error instanceof Error ? error.message : String(error)}。可重试或选择“仅恢复文字”。`);
    } finally {
      // Failed recovery must not release the only lease protecting the source
      // backup. Hold it until a successful import, explicit clear or expiry.
      recoveryBusyRef.current = false;
      syncLeases(stateRef.current);
      if (mountedRef.current) setRecovering(false);
    }
  };
  const dismissRecovery = (record: RecoveryRecord) => {
    storage().consume(record);
    dismissedRecoveriesRef.current.add(`${record.id}:${record.sequence}`);
    setRecoveries((records) => records.filter((item) => item.id !== record.id || item.sequence !== record.sequence));
  };

  const backupNeedsCloseWarning = useCallback(() => storageRef.current?.needsCloseWarning() || false, []);

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
    attachmentOwner: () => storage().owner,
    backupNeedsCloseWarning,
    submit,
    storageWarning: [storageWarning, leaseWarning].filter(Boolean).join(" "),
    recoveryNotice,
    recoveries,
    recovering,
    restoreRecovery,
    dismissRecovery,
  };
}
