import type { PiMessage, SessionViewData } from "../../shared/types";
import {
  SessionViewCache,
  type PaneTransientPatch,
  type SessionViewSnapshot,
} from "../lib/session-view-cache";

export type SessionViewCacheWriteAuthority = {
  runEpochGeneration: number;
  cacheGeneration: number;
};

export type PrepareSessionViewCacheWrite = (
  view: SessionViewData,
) => SessionViewData;

/**
 * The sole mutation boundary for browser-local SessionView cache state.
 *
 * Async authoritative views must carry the Runtime generation captured before
 * their await. Same-process stale navigation can still populate its Session's
 * cache, while replacement-process and deleted-Session writes fail closed.
 * Synchronous event patches use the current generation inside this owner.
 */
export class SessionViewCacheWriter {
  private cacheGeneration = 0;

  constructor(
    private readonly cache: SessionViewCache,
    private readonly currentRunEpochGeneration: () => number,
    private readonly sessionDeleted: (sessionId: string) => boolean,
  ) {}

  captureAuthority(
    runEpochGeneration: number,
  ): SessionViewCacheWriteAuthority {
    return { runEpochGeneration, cacheGeneration: this.cacheGeneration };
  }

  isCurrent(authority: SessionViewCacheWriteAuthority): boolean {
    return authority.runEpochGeneration === this.currentRunEpochGeneration()
      && authority.cacheGeneration === this.cacheGeneration;
  }

  remember(
    view: SessionViewData,
    authority: SessionViewCacheWriteAuthority,
    prepare?: PrepareSessionViewCacheWrite,
  ): SessionViewSnapshot | undefined {
    if (!this.accepts(view.session.id, authority)) return undefined;
    return this.cache.remember(prepare ? prepare(view) : view);
  }

  mergeNavigation(
    view: SessionViewData,
    requestStartRevision: number,
    authority: SessionViewCacheWriteAuthority,
  ): SessionViewSnapshot | undefined {
    if (!this.accepts(view.session.id, authority)) return undefined;
    return this.cache.mergeNavigation(view, requestStartRevision);
  }

  refresh(
    sessionId: string,
    patch: Partial<SessionViewData>,
    authority: SessionViewCacheWriteAuthority,
  ): SessionViewSnapshot | undefined {
    if (!this.accepts(sessionId, authority)) return undefined;
    return this.cache.refresh(sessionId, patch);
  }

  refreshCurrent(
    sessionId: string,
    patch: Partial<SessionViewData>,
  ): SessionViewSnapshot | undefined {
    if (this.sessionDeleted(sessionId)) return undefined;
    return this.cache.refresh(sessionId, patch);
  }

  patch(
    sessionId: string,
    patch: PaneTransientPatch,
    authority: SessionViewCacheWriteAuthority,
  ): SessionViewSnapshot | undefined {
    if (!this.accepts(sessionId, authority)) return undefined;
    return this.cache.patch(sessionId, patch);
  }

  patchCurrent(
    sessionId: string,
    patch: PaneTransientPatch,
  ): SessionViewSnapshot | undefined {
    if (this.sessionDeleted(sessionId)) return undefined;
    return this.cache.patch(sessionId, patch);
  }

  updateLiveCurrent(
    sessionId: string,
    message: PiMessage | undefined,
  ): SessionViewSnapshot | undefined {
    if (this.sessionDeleted(sessionId)) return undefined;
    return this.cache.updateLive(sessionId, message);
  }

  appendTerminalCurrent(
    sessionId: string,
    message: PiMessage,
  ): SessionViewSnapshot | undefined {
    if (this.sessionDeleted(sessionId)) return undefined;
    return this.cache.appendTerminal(sessionId, message);
  }

  setPinnedCurrent(sessionIds: Iterable<string>): void {
    this.cache.setPinned(sessionIds);
  }

  forget(
    sessionId: string,
    authority: SessionViewCacheWriteAuthority,
  ): boolean {
    if (!this.accepts(sessionId, authority)) return false;
    this.cache.forget(sessionId);
    return true;
  }

  forgetCurrent(sessionId: string): void {
    this.cache.forget(sessionId);
  }

  clearForReplacement(): void {
    this.cacheGeneration += 1;
    this.cache.clear();
  }

  private accepts(
    sessionId: string,
    authority: SessionViewCacheWriteAuthority,
  ): boolean {
    return !this.sessionDeleted(sessionId) && this.isCurrent(authority);
  }
}
