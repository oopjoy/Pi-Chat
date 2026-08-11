import { mergeMessageHistory, reconcilePersistedHistory, userTurnCount } from "../../shared/streaming-assistant";
import type { PiMessage, PiState, SessionActivityState, SessionViewData } from "../../shared/types";

export type SessionViewSnapshot = SessionViewData & { cachedAt: number };

/** Fields that SSE may update after an HTTP view request has started. */
export type PaneTransientPatch = Partial<Pick<SessionViewData,
  "liveMessage" | "toolStatus" | "queue" | "queuePaused" | "gateMode" |
  "pendingExtensionRequest" | "controlOwner" | "controlledByThisWindow" |
  "isStreaming" | "runtimeStatus">> & {
  /** A newer SSE activity snapshot must survive an older HTTP Session view. */
  sessionActivity?: SessionActivityState;
  /** State fields are independently transient; never snapshot the whole PiState. */
  state?: Partial<PiState>;
};

type PaneTransientKey = keyof Omit<PaneTransientPatch, "state">;
interface OverlayValue { revision: number; value: unknown; }
type StateOverlay = Partial<Record<keyof PiState, OverlayValue>>;
type PaneOverlay = Partial<Record<PaneTransientKey, OverlayValue>> & { state?: StateOverlay };

/**
 * Data-only pane cache. Hot Runtime views are pinned so browsing cold history
 * cannot evict the buffers needed for instant Session switching. It stores view
 * data, never React elements or pre-rendered Markdown.
 */
export class SessionViewCache {
  private readonly views = new Map<string, SessionViewSnapshot>();
  /** Server/RPC branch without temporary SSE terminal leases. */
  private readonly persistedMessages = new Map<string, PiMessage[]>();
  /** message_end rows retained until a later authoritative view confirms them. */
  private readonly terminalTails = new Map<string, PiMessage[]>();
  /** Per-field SSE overlays, so an old queue event cannot outlive a new HTTP view. */
  private readonly overlays = new Map<string, PaneOverlay>();
  private readonly pinned = new Set<string>();
  private revision = 0;

  constructor(private readonly coldLimit = 6, private readonly now: () => number = Date.now) {}

  setPinned(ids: Iterable<string>): void {
    this.pinned.clear();
    for (const id of ids) if (id) this.pinned.add(id);
    this.pruneUnpinnedSparseState();
    this.evictCold();
  }

  revisionFor(id: string): number {
    const overlay = this.overlays.get(id);
    if (!overlay) return 0;
    const fieldRevisions = Object.values(overlay)
      .filter((entry): entry is OverlayValue => Boolean(entry && "revision" in entry))
      .map((entry) => entry.revision);
    const stateRevisions = Object.values(overlay.state || {}).map((entry) => entry?.revision || 0);
    return Math.max(0, ...fieldRevisions, ...stateRevisions);
  }

  /** Store a streaming draft without forcing React to render an off-screen pane. */
  updateLive(id: string, message: PiMessage | undefined): SessionViewSnapshot | undefined {
    return this.patch(id, {
      liveMessage: message,
      ...(message ? { isStreaming: true, state: { isStreaming: true } } : null),
    });
  }

  private recordOverlay(id: string, patch: PaneTransientPatch): void {
    const previous = this.overlays.get(id) || {};
    const next: PaneOverlay = { ...previous };
    for (const key of Object.keys(patch).filter((key): key is PaneTransientKey => key !== "state")) {
      const value = patch[key];
      next[key] = { revision: ++this.revision, value };
    }
    const state = { ...(previous.state || {}) };
    for (const [stateKey, stateValue] of Object.entries(patch.state || {})) {
      if (stateValue !== undefined) state[stateKey as keyof PiState] = { revision: ++this.revision, value: stateValue };
    }
    if (Object.keys(state).length) next.state = state;
    if (Object.keys(next).length) this.overlays.set(id, next);
  }

  private overlayAfter(id: string, minRevision: number): PaneTransientPatch {
    const overlay = this.overlays.get(id);
    if (!overlay) return {};
    const patch: PaneTransientPatch = {};
    for (const key of Object.keys(overlay) as PaneTransientKey[]) {
      const entry = overlay[key];
      if (entry && entry.revision > minRevision) (patch as Record<string, unknown>)[key] = entry.value;
    }
    const state = Object.fromEntries(Object.entries(overlay.state || {})
      .filter(([, entry]) => entry && entry.revision > minRevision)
      .map(([key, entry]) => [key, entry!.value])) as Partial<PiState>;
    if (Object.keys(state).length) patch.state = state;
    return patch;
  }

  private discardOverlayThrough(id: string, revision: number): void {
    const overlay = this.overlays.get(id);
    if (!overlay) return;
    for (const key of Object.keys(overlay).filter((key): key is PaneTransientKey => key !== "state")) {
      if ((overlay[key]?.revision || 0) <= revision) delete overlay[key];
    }
    if (overlay.state) {
      for (const key of Object.keys(overlay.state) as Array<keyof PiState>) {
        if ((overlay.state[key]?.revision || 0) <= revision) delete overlay.state[key];
      }
      if (!Object.keys(overlay.state).length) delete overlay.state;
    }
    if (Object.keys(overlay).length) this.overlays.set(id, overlay);
    else this.overlays.delete(id);
  }

  private applyOverlay<T extends SessionViewSnapshot | SessionViewData>(id: string, view: T, minRevision = 0): T {
    const patch = this.overlayAfter(id, minRevision);
    if (!Object.keys(patch).length) return view;
    const { sessionActivity, controlOwner, controlledByThisWindow, ...fields } = patch;
    // `undefined` is meaningful for controlOwner: an SSE clear must remove a
    // former owner rather than retaining it through nullish fallback.
    const hasControlOwner = Object.hasOwn(patch, "controlOwner");
    const hasControlledByThisWindow = Object.hasOwn(patch, "controlledByThisWindow");
    const control = hasControlOwner || hasControlledByThisWindow
      ? {
          controlOwner: hasControlOwner ? controlOwner : view.controlOwner ?? view.session.controlOwner,
          controlledByThisWindow: hasControlledByThisWindow ? controlledByThisWindow : view.controlledByThisWindow ?? view.session.controlledByThisWindow,
        }
      : null;
    return {
      ...view,
      ...fields,
      ...control,
      ...(sessionActivity ? { session: { ...view.session, activity: sessionActivity } } : null),
      ...(control ? { session: { ...(sessionActivity ? { ...view.session, activity: sessionActivity } : view.session), ...control } } : null),
      ...(patch.state ? { state: { ...view.state, ...patch.state } } : null),
    } as T;
  }

  /** Cache only server/RPC facts. Local user overlays are applied after this layer. */
  private storeAuthoritative(view: SessionViewData): SessionViewSnapshot {
    const id = view.session.id;
    const previous = this.views.get(id);
    const previousPersisted = this.persistedMessages.get(id) || [];
    // A settled JSONL/runtime view is authoritative even when its active branch
    // is a strict prefix of a cached branch. Only a genuinely streaming view
    // may merge history; terminal SSE tails are reconciled independently below.
    const preserveStreamingTranscript = Boolean(previous && (view.isStreaming || view.state.isStreaming));
    const persisted = preserveStreamingTranscript
      ? mergeMessageHistory(previousPersisted, view.messages)
      : view.messages;
    const reconciled = reconcilePersistedHistory(persisted, this.terminalTails.get(id) || []);
    this.persistedMessages.set(id, persisted);
    if (reconciled.pending.length) this.terminalTails.set(id, reconciled.pending);
    else this.terminalTails.delete(id);

    const pendingUserTurns = userTurnCount(reconciled.pending);
    const snapshot: SessionViewSnapshot = {
      ...previous,
      ...view,
      messages: reconciled.messages,
      messageTotal: Math.max(view.messageTotal + reconciled.pending.length, reconciled.messages.length),
      turnTotal: Math.max(view.turnTotal || 0, userTurnCount(persisted)) + pendingUserTurns,
      liveMessage: (view.isStreaming || view.state.isStreaming)
        ? view.liveMessage || previous?.liveMessage
        : view.liveMessage,
      // A hot partial view intentionally omits commands while its Runtime is
      // busy. A cold JSONL view likewise has no Runtime command discovery at
      // all, so its protocol-level [] is not evidence that a previously warm
      // Session lost its commands. Only an explicit non-cold [] clears cache.
      commands:
        view.viewSource === "cold-jsonl" && !view.commands?.length
          ? previous?.commands
          : view.commands ?? previous?.commands,
      cachedAt: this.now(),
    };
    this.views.delete(id);
    this.views.set(id, snapshot);
    this.evictCold();
    return snapshot;
  }

  /** Confirm every transient field present before this authoritative response. */
  remember(view: SessionViewData): SessionViewSnapshot {
    // Materialized cache snapshots must never become evidence that their own SSE
    // overlay or terminal lease has persisted to JSONL.
    if ("cachedAt" in view) return view as SessionViewSnapshot;
    const hadView = this.views.has(view.session.id);
    const snapshot = this.storeAuthoritative(view);
    // A stream can start before this browser has ever opened its hot pane. Fold
    // that sparse first draft into the initial snapshot once, then clear it.
    // For an existing pane, the incoming authoritative response confirms and
    // replaces all prior transient fields instead.
    const resolved = hadView ? snapshot : this.applyOverlay(view.session.id, snapshot);
    this.overlays.delete(view.session.id);
    if (resolved !== snapshot) {
      this.views.delete(view.session.id);
      this.views.set(view.session.id, resolved);
    }
    return resolved;
  }

  /**
   * Merge a navigation response with only events received after its request began.
   * Earlier overlays are confirmed by the response; later fields remain pending.
   */
  mergeNavigation(view: SessionViewData, requestStartRevision: number): SessionViewSnapshot {
    const snapshot = this.storeAuthoritative(view);
    this.discardOverlayThrough(view.session.id, requestStartRevision);
    const merged = this.applyOverlay(view.session.id, snapshot, requestStartRevision);
    this.views.delete(view.session.id);
    this.views.set(view.session.id, merged);
    return merged;
  }

  /** Apply only explicitly transient SSE state; use remember() for HTTP views. */
  patch(id: string, patch: PaneTransientPatch): SessionViewSnapshot | undefined {
    this.recordOverlay(id, patch);
    const { state: statePatch, sessionActivity, controlOwner, controlledByThisWindow, ...fields } = patch;
    const hasControlOwner = Object.hasOwn(patch, "controlOwner");
    const hasControlledByThisWindow = Object.hasOwn(patch, "controlledByThisWindow");
    const previous = this.views.get(id);
    if (!previous) return undefined;
    const persisted = this.persistedMessages.get(id) || [];
    const reconciled = reconcilePersistedHistory(persisted, this.terminalTails.get(id) || []);
    const control = hasControlOwner || hasControlledByThisWindow
      ? {
          controlOwner: hasControlOwner ? controlOwner : previous.controlOwner ?? previous.session.controlOwner,
          controlledByThisWindow: hasControlledByThisWindow ? controlledByThisWindow : previous.controlledByThisWindow ?? previous.session.controlledByThisWindow,
        }
      : null;
    const next: SessionViewSnapshot = {
      ...previous,
      ...fields,
      ...control,
      ...(sessionActivity ? { session: { ...previous.session, activity: sessionActivity } } : null),
      ...(control ? { session: { ...(sessionActivity ? { ...previous.session, activity: sessionActivity } : previous.session), ...control } } : null),
      messages: reconciled.messages,
      messageTotal: previous.messageTotal,
      turnTotal: previous.turnTotal,
      visibleTurnCount: previous.visibleTurnCount,
      messagesTruncated: previous.messagesTruncated,
      ...(statePatch ? { state: { ...previous.state, ...statePatch } } : null),
      cachedAt: this.now(),
    };
    this.views.delete(id);
    this.views.set(id, next);
    return next;
  }

  /** Update a known cache entry without creating a transient SSE overlay. */
  refresh(id: string, patch: Partial<SessionViewData>): SessionViewSnapshot | undefined {
    const previous = this.views.get(id);
    if (!previous) return undefined;
    const persisted = this.persistedMessages.get(id) || [];
    const reconciled = reconcilePersistedHistory(persisted, this.terminalTails.get(id) || []);
    const next: SessionViewSnapshot = {
      ...previous,
      ...patch,
      session: patch.session || previous.session,
      messages: reconciled.messages,
      messageTotal: previous.messageTotal,
      turnTotal: previous.turnTotal,
      visibleTurnCount: previous.visibleTurnCount,
      messagesTruncated: previous.messagesTruncated,
      ...(patch.state ? { state: { ...previous.state, ...patch.state } } : null),
      cachedAt: this.now(),
    };
    this.views.delete(id);
    this.views.set(id, next);
    return next;
  }

  appendTerminal(id: string, message: PiMessage): SessionViewSnapshot | undefined {
    this.recordOverlay(id, { liveMessage: message.role === "assistant" ? undefined : this.views.get(id)?.liveMessage });
    const previous = this.views.get(id);
    const tail = this.terminalTails.get(id) || [];
    const reconciled = reconcilePersistedHistory(this.persistedMessages.get(id) || [], [...tail, message]);
    if (reconciled.pending.length) this.terminalTails.set(id, reconciled.pending);
    else this.terminalTails.delete(id);
    if (!previous) return undefined;
    const next: SessionViewSnapshot = {
      ...previous,
      messages: reconciled.messages,
      messageTotal: Math.max(previous.messageTotal, reconciled.messages.length),
      turnTotal: Math.max(previous.turnTotal || 0, userTurnCount(this.persistedMessages.get(id) || [])) + userTurnCount(reconciled.pending),
      liveMessage: message.role === "assistant" ? undefined : previous.liveMessage,
      cachedAt: this.now(),
    };
    this.views.delete(id);
    this.views.set(id, next);
    return next;
  }

  forget(id: string): void {
    this.views.delete(id);
    this.persistedMessages.delete(id);
    this.terminalTails.delete(id);
    this.overlays.delete(id);
    this.pinned.delete(id);
  }

  get(id: string): SessionViewSnapshot | undefined {
    const view = this.views.get(id);
    if (!view) return undefined;
    this.views.delete(id);
    this.views.set(id, view);
    return this.applyOverlay(id, view);
  }

  /**
   * SSE can arrive before a pane has ever received an authoritative view. That
   * sparse state is useful only while its Runtime remains hot; once it is no
   * longer pinned there is no browser pane to restore and JSONL is authoritative.
   * Keep ordinary unpinned cold views for LRU navigation, but bound these
   * otherwise-unreachable overlay/tail maps.
   */
  private pruneUnpinnedSparseState(): void {
    const sparseIds = new Set([
      ...this.persistedMessages.keys(),
      ...this.terminalTails.keys(),
      ...this.overlays.keys(),
    ]);
    for (const id of sparseIds) {
      if (!this.pinned.has(id) && !this.views.has(id)) this.forget(id);
    }
  }

  private evictCold(): void {
    let coldCount = [...this.views.keys()].filter((id) => !this.pinned.has(id)).length;
    for (const id of [...this.views.keys()]) {
      if (coldCount <= this.coldLimit) break;
      if (this.pinned.has(id)) continue;
      this.forget(id);
      coldCount -= 1;
    }
  }
}
