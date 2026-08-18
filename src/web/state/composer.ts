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
  suspended?: ComposerDraft;
};

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
  | { type: "accept"; snapshot: ComposerSnapshot; retry: boolean }
  | { type: "start-delivery"; key: ComposerDraftKey }
  | { type: "delivery-accepted"; key: ComposerDraftKey }
  | { type: "delivery-unknown"; key: ComposerDraftKey }
  | { type: "delivery-rejected"; key: ComposerDraftKey }
  | {
      type: "restore-cancelled";
      key: ComposerDraftKey;
      expectedRevision: number;
      message: string;
      images: PromptImage[];
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
    });
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
      suspended: hasNewerDraft ? partition.draft : partition.suspended,
      draft: {
        message: failed.message,
        images: [...failed.images],
        revision: partition.draft.revision,
      },
    });
  }
  if (action.type === "restore-cancelled") {
    if (partition.draft.revision !== action.expectedRevision) return state;
    return withPartition(state, action.key, {
      ...partition,
      draft: {
        message: action.message,
        images: [...action.images],
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
