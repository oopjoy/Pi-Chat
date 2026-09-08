import { MAX_PROMPT_IMAGES_TOTAL_BYTES } from "../../shared/rpc-contracts";
import type { PromptDelivery, PromptImage } from "../../shared/types";

/**
 * A draft belongs to the ordinary prompt target, not merely the currently
 * painted pane. This keeps a verified child transcript from borrowing its
 * parent's unsent editor content, while retaining correct parent routing.
 */
export type ComposerDraftKey =
  | { kind: "session"; sessionId: string }
  | { kind: "new"; generation: number };

export function composerDraftKeyId(key: ComposerDraftKey): string {
  return key.kind === "session"
    ? `session:${key.sessionId}`
    : `draft:${key.generation}`;
}

export type ComposerDraft = {
  message: string;
  images: PromptImage[];
  revision: number;
};

export type ComposerSnapshot = ComposerDraft & {
  key: ComposerDraftKey;
  targetSessionId?: string;
  delivery: PromptDelivery;
};

type ComposerPartition = {
  draft: ComposerDraft;
  pending: ComposerSnapshot[];
  inFlight?: ComposerSnapshot;
  blocked?: ComposerSnapshot;
  blockedError?: string;
  suspended?: ComposerDraft;
};

/** Browser-local bounds for accepted-but-not-yet-delivered editor payloads. */
export const MAX_COMPOSER_PENDING_SNAPSHOTS = 64;
export const MAX_COMPOSER_PENDING_IMAGE_BYTES = MAX_PROMPT_IMAGES_TOTAL_BYTES * 2;
export const MAX_COMPOSER_PENDING_PAYLOAD_BYTES = 128 * 1024 * 1024;

function promptImageRawBytes(image: Pick<PromptImage, "data" | "size">): number {
  const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
  const encodedBytes = Math.max(0, Math.floor(image.data.length * 3 / 4) - padding);
  const declaredBytes = typeof image.size === "number" && Number.isFinite(image.size)
    ? Math.max(0, Math.floor(image.size))
    : 0;
  return Math.max(encodedBytes, declaredBytes);
}

function payloadBytes(payload: Pick<ComposerDraft, "message" | "images">): number {
  // JS strings are UTF-16. This intentionally estimates retained heap rather
  // than wire size so a queue of Base64 image strings cannot grow unbounded.
  return payload.message.length * 2
    + payload.images.reduce((total, image) => total + image.data.length * 2, 0);
}

function payloadImageBytes(payload: Pick<ComposerDraft, "images">): number {
  return payload.images.reduce((total, image) => total + promptImageRawBytes(image), 0);
}

export interface ComposerPendingUsage {
  snapshots: number;
  imageBytes: number;
  payloadBytes: number;
}

function addDraftUsage(usage: ComposerPendingUsage, draft: ComposerDraft): void {
  usage.imageBytes += payloadImageBytes(draft);
  usage.payloadBytes += payloadBytes(draft);
}

function addSnapshotUsage(usage: ComposerPendingUsage, snapshot: ComposerSnapshot): void {
  usage.snapshots += 1;
  usage.imageBytes += payloadImageBytes(snapshot);
  usage.payloadBytes += payloadBytes(snapshot);
}

export function composerPendingUsage(state: ComposerState): ComposerPendingUsage {
  const usage: ComposerPendingUsage = { snapshots: 0, imageBytes: 0, payloadBytes: 0 };
  for (const partition of Object.values(state.partitions)) {
    if (!partition) continue;
    addDraftUsage(usage, partition.draft);
    if (partition.suspended) addDraftUsage(usage, partition.suspended);
    for (const snapshot of partition.pending) addSnapshotUsage(usage, snapshot);
    if (partition.inFlight) addSnapshotUsage(usage, partition.inFlight);
    if (partition.blocked) addSnapshotUsage(usage, partition.blocked);
  }
  return usage;
}

/** Return a user-facing reason before an accepted snapshot enters local state. */
export function composerAcceptError(
  state: ComposerState,
  snapshot: ComposerSnapshot,
  retry: boolean,
): string | null {
  const usage = composerPendingUsage(state);
  const partition = state.partitions[composerDraftKeyId(snapshot.key)];
  // Accept clears this editor draft; a retry also replaces its blocked copy.
  if (partition) {
    usage.imageBytes -= payloadImageBytes(partition.draft);
    usage.payloadBytes -= payloadBytes(partition.draft);
    if (retry && partition.blocked) {
      usage.snapshots -= 1;
      usage.imageBytes -= payloadImageBytes(partition.blocked);
      usage.payloadBytes -= payloadBytes(partition.blocked);
    }
  }
  usage.snapshots += 1;
  usage.imageBytes += payloadImageBytes(snapshot);
  usage.payloadBytes += payloadBytes(snapshot);
  if (usage.snapshots > MAX_COMPOSER_PENDING_SNAPSHOTS)
    return `待发送消息过多，最多保留 ${MAX_COMPOSER_PENDING_SNAPSHOTS} 条；请等待已有消息送达`;
  if (usage.imageBytes > MAX_COMPOSER_PENDING_IMAGE_BYTES)
    return "编辑器中待发送图片总量超过 80 MB，请先等待已有消息送达";
  if (usage.payloadBytes > MAX_COMPOSER_PENDING_PAYLOAD_BYTES)
    return "编辑器待发送内容占用过大，请先等待已有消息送达";
  return null;
}

export type ComposerState = {
  partitions: Record<string, ComposerPartition | undefined>;
};

export const emptyComposerState = (): ComposerState => ({ partitions: {} });

const emptyDraft = (): ComposerDraft => ({ message: "", images: [], revision: 0 });

function partitionFor(state: ComposerState, key: ComposerDraftKey): ComposerPartition {
  return state.partitions[composerDraftKeyId(key)] || {
    draft: emptyDraft(),
    pending: [],
  };
}

function withPartition(
  state: ComposerState,
  key: ComposerDraftKey,
  partition: ComposerPartition,
): ComposerState {
  return {
    partitions: {
      ...state.partitions,
      [composerDraftKeyId(key)]: partition,
    },
  };
}

function editDraft(
  partition: ComposerPartition,
  patch: Pick<ComposerDraft, "message" | "images">,
): ComposerPartition {
  return {
    ...partition,
    draft: {
      ...patch,
      revision: partition.draft.revision + 1,
    },
  };
}

function restoreSuspended(partition: ComposerPartition): ComposerPartition {
  if (
    !partition.suspended ||
    partition.pending.length ||
    partition.inFlight ||
    partition.blocked ||
    partition.draft.message.trim() ||
    partition.draft.images.length
  )
    return partition;
  return { ...partition, draft: partition.suspended, suspended: undefined };
}

export type ComposerAction =
  | { type: "edit"; key: ComposerDraftKey; message: string }
  | { type: "replace"; key: ComposerDraftKey; message: string; images: PromptImage[] }
  | { type: "clear"; key: ComposerDraftKey }
  /** Drop all retained text/images for a structurally deleted Session. */
  | { type: "forget"; key: ComposerDraftKey }
  | { type: "accept"; snapshot: ComposerSnapshot; retry: boolean }
  | { type: "start-delivery"; key: ComposerDraftKey }
  | { type: "delivery-accepted"; key: ComposerDraftKey }
  | { type: "delivery-unknown"; key: ComposerDraftKey }
  | { type: "delivery-rejected"; key: ComposerDraftKey; error?: string }
  | {
      type: "restore-cancelled";
      key: ComposerDraftKey;
      expectedRevision: number;
      message: string;
      images: PromptImage[];
      /** Native Pi dequeue prepends restored queue text to the current editor. */
      prepend?: boolean;
    };

/**
 * Pure Composer transitions. Effects are deliberately excluded: App remains
 * the authority for API, SSE, local turns, and uncertain RPC outcomes.
 */
export function composerReducer(
  state: ComposerState,
  action: ComposerAction,
): ComposerState {
  if (action.type === "accept") {
    // A caller may retain and later mutate its image array; the accepted
    // snapshot belongs to this transition and must remain immutable.
    const snapshot = { ...action.snapshot, images: [...action.snapshot.images] };
    const partition = partitionFor(state, snapshot.key);
    const pending = action.retry
      ? [snapshot, ...partition.pending]
      : [...partition.pending, snapshot];
    return withPartition(state, snapshot.key, {
      ...partition,
      draft: {
        message: "",
        images: [],
        revision: partition.draft.revision + 1,
      },
      pending,
      blocked: undefined,
      blockedError: undefined,
    });
  }

  if (action.type === "forget") {
    const keyId = composerDraftKeyId(action.key);
    if (!(keyId in state.partitions)) return state;
    const partitions = { ...state.partitions };
    delete partitions[keyId];
    return { partitions };
  }

  const partition = partitionFor(state, action.key);
  if (action.type === "edit")
    return withPartition(state, action.key, editDraft(partition, {
      message: action.message,
      images: partition.draft.images,
    }));
  if (action.type === "replace")
    return withPartition(state, action.key, {
      ...partition,
      draft: {
        message: action.message,
        images: [...action.images],
        revision: partition.draft.revision,
      },
    });
  if (action.type === "clear")
    return withPartition(state, action.key, editDraft(partition, {
      message: "",
      images: [],
    }));
  if (action.type === "start-delivery") {
    const [next, ...pending] = partition.pending;
    if (!next || partition.inFlight) return state;
    return withPartition(state, action.key, { ...partition, pending, inFlight: next });
  }
  if (action.type === "delivery-accepted" || action.type === "delivery-unknown")
    return withPartition(
      state,
      action.key,
      restoreSuspended({ ...partition, inFlight: undefined }),
    );
  if (action.type === "delivery-rejected") {
    const failed = partition.inFlight;
    if (!failed) return state;
    const hasNewerDraft = partition.draft.message.trim() || partition.draft.images.length;
    return withPartition(state, action.key, {
      ...partition,
      inFlight: undefined,
      blocked: failed,
      blockedError: action.error?.trim().slice(0, 1_000) || "修改后可重试",
      suspended: hasNewerDraft ? partition.draft : partition.suspended,
      draft: {
        message: failed.message,
        images: [...failed.images],
        revision: partition.draft.revision,
      },
    });
  }
  if (action.type === "restore-cancelled") {
    if (!action.prepend && partition.draft.revision !== action.expectedRevision)
      return state;
    return withPartition(state, action.key, {
      ...partition,
      draft: {
        message: action.prepend
          ? [action.message, partition.draft.message]
              .filter((message) => message.trim())
              .join("\n\n")
          : action.message,
        images: action.prepend
          ? [...action.images, ...partition.draft.images]
          : [...action.images],
        revision: partition.draft.revision,
      },
    });
  }
  return state;
}

export function composerPartition(
  state: ComposerState,
  key: ComposerDraftKey,
): ComposerPartition {
  return partitionFor(state, key);
}
