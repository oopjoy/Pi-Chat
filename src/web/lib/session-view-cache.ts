import { mergeMessageHistory, messageSequenceAt, reconcilePersistedHistory, userTurnCount } from "../../shared/streaming-assistant";
import type { PiMessage, SessionViewData } from "../../shared/types";

export type SessionViewSnapshot = SessionViewData & { cachedAt: number };

export class SessionViewCache {
  private readonly views = new Map<string, SessionViewSnapshot>();
  /** Server/RPC branch without temporary SSE terminal leases. */
  private readonly persistedMessages = new Map<string, PiMessage[]>();
  /** message_end rows retained until a later authoritative view confirms them. */
  private readonly terminalTails = new Map<string, PiMessage[]>();

  constructor(private readonly limit = 5, private readonly now: () => number = Date.now) {}

  /** Cache only server/RPC facts. Local user overlays are applied after this layer. */
  remember(view: SessionViewData): SessionViewSnapshot {
    const id = view.session.id;
    const previous = this.views.get(id);
    // Cached navigation may feed the exact snapshot back through applySessionView.
    // It already contains terminal leases and must not promote them to persisted.
    if (previous === view) return previous;
    const previousPersisted = this.persistedMessages.get(id) || [];
    const incomingIsStrictOldPrefix = Boolean(previousPersisted.length
      && view.messages.length < previousPersisted.length
      && messageSequenceAt(previousPersisted, view.messages) === 0);
    const preserveStreamingTranscript = Boolean(previous && (view.isStreaming || view.state.isStreaming || incomingIsStrictOldPrefix));
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
      // A busy read may lag behind the cumulative SSE draft. Preserve that draft
      // until a terminal event or an explicitly idle view clears it.
      liveMessage: (view.isStreaming || view.state.isStreaming)
        ? view.liveMessage || previous?.liveMessage
        : view.liveMessage,
      cachedAt: this.now(),
    };
    this.views.delete(id);
    this.views.set(id, snapshot);
    while (this.views.size > this.limit) {
      const oldest = this.views.keys().next().value;
      if (!oldest) break;
      this.views.delete(oldest);
      this.persistedMessages.delete(oldest);
      this.terminalTails.delete(oldest);
    }
    return snapshot;
  }

  patch(id: string, patch: Partial<SessionViewData>): SessionViewSnapshot | undefined {
    const previous = this.views.get(id);
    if (!previous) return undefined;
    const persisted = this.persistedMessages.get(id) || [];
    const reconciled = reconcilePersistedHistory(persisted, this.terminalTails.get(id) || []);
    const next: SessionViewSnapshot = {
      ...previous,
      ...patch,
      session: patch.session || previous.session,
      messages: reconciled.messages,
      // patch() carries only transient Runtime/SSE fields. Counts remain tied to
      // the last authoritative remember()/appendTerminal() reconciliation.
      messageTotal: previous.messageTotal,
      turnTotal: previous.turnTotal,
      visibleTurnCount: previous.visibleTurnCount,
      messagesTruncated: previous.messagesTruncated,
      cachedAt: this.now(),
    };
    this.views.delete(id);
    this.views.set(id, next);
    return next;
  }

  appendTerminal(id: string, message: PiMessage): SessionViewSnapshot | undefined {
    const previous = this.views.get(id);
    if (!previous) return undefined;
    const tail = this.terminalTails.get(id) || [];
    const reconciled = reconcilePersistedHistory(this.persistedMessages.get(id) || [], [...tail, message]);
    if (reconciled.pending.length) this.terminalTails.set(id, reconciled.pending);
    else this.terminalTails.delete(id);
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
  }

  get(id: string): SessionViewSnapshot | undefined {
    return this.views.get(id);
  }
}
