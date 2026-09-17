export type ActiveSessionProjectionAuthority = {
  runEpochGeneration: number;
  activeSessionProjectionGeneration: number;
  activeSessionFullRevision: number;
};

export type ActiveSessionViewAuthority = {
  runEpochGeneration: number;
  activeSessionProjectionGeneration: number;
  activeSessionId: string;
  activeSessionRevision: number;
};

export type ActiveSessionDraftAuthority = {
  runEpochGeneration: number;
  activeSessionProjectionGeneration: number;
};

export type ActiveSessionViewDecision = {
  active: boolean;
  accepted: boolean;
};

function normalizedIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((id, index) => id === right[index]);
}

/**
 * Sole browser write/freshness boundary for the server-owned hot Session set.
 *
 * Full Bootstrap/SSE snapshots retire every older view observation. A current
 * Session view may refine only its own membership; that retires older reads for
 * the same Session and full Bootstrap requests without rejecting unrelated
 * Session reads.
 */
export class ActiveSessionProjectionWriter {
  private projectionGeneration = 0;
  private fullRevision = 0;
  private ids: string[] = [];
  private readonly sessionRevisions = new Map<string, number>();

  constructor(
    private readonly sink: (ids: string[]) => void,
    private readonly currentRunEpochGeneration: () => number,
  ) {}

  captureAuthority(
    runEpochGeneration: number,
  ): ActiveSessionProjectionAuthority {
    return {
      runEpochGeneration,
      activeSessionProjectionGeneration: this.projectionGeneration,
      activeSessionFullRevision: this.fullRevision,
    };
  }

  captureDraftAuthority(
    runEpochGeneration: number,
  ): ActiveSessionDraftAuthority {
    return {
      runEpochGeneration,
      activeSessionProjectionGeneration: this.projectionGeneration,
    };
  }

  captureViewAuthority(
    runEpochGeneration: number,
    sessionId: string,
  ): ActiveSessionViewAuthority {
    return {
      runEpochGeneration,
      activeSessionProjectionGeneration: this.projectionGeneration,
      activeSessionId: sessionId,
      activeSessionRevision: this.sessionRevisions.get(sessionId) || 0,
    };
  }

  isCurrent(authority: ActiveSessionProjectionAuthority): boolean {
    return authority.runEpochGeneration === this.currentRunEpochGeneration()
      && authority.activeSessionProjectionGeneration ===
        this.projectionGeneration
      && authority.activeSessionFullRevision === this.fullRevision;
  }

  currentIds(): string[] {
    return [...this.ids];
  }

  commitBootstrap(
    ids: readonly string[],
    authority: ActiveSessionProjectionAuthority,
  ): boolean {
    if (!this.isCurrent(authority)) return false;
    this.projectionGeneration += 1;
    this.fullRevision += 1;
    this.replaceIds(ids);
    return true;
  }

  observeSse(ids: readonly string[]): boolean {
    const next = normalizedIds(ids);
    const changed = !sameIds(this.ids, next);
    // Event order is freshness evidence even when the projected set is equal.
    // A reclaim frame that repeats the browser's current set must still retire
    // an older response which observed a transient hot Runtime.
    this.projectionGeneration += 1;
    this.fullRevision += 1;
    if (changed) this.replaceIds(next);
    return changed;
  }

  projectSessionView(sessionId: string): ActiveSessionViewDecision {
    return { active: this.ids.includes(sessionId), accepted: false };
  }

  reconcileSessionView(
    sessionId: string,
    reportedActive: boolean,
    authority: ActiveSessionViewAuthority
      | ActiveSessionProjectionAuthority
      | ActiveSessionDraftAuthority,
  ): ActiveSessionViewDecision {
    const currentActive = this.ids.includes(sessionId);
    const viewSpecific = "activeSessionId" in authority;
    const fullSnapshot = "activeSessionFullRevision" in authority;
    if (
      !sessionId
      || authority.runEpochGeneration !== this.currentRunEpochGeneration()
      || authority.activeSessionProjectionGeneration !==
        this.projectionGeneration
      || (viewSpecific
        ? authority.activeSessionId !== sessionId
          || authority.activeSessionRevision !==
            (this.sessionRevisions.get(sessionId) || 0)
        : fullSnapshot
          && authority.activeSessionFullRevision !== this.fullRevision)
    ) return { active: currentActive, accepted: false };

    if (reportedActive !== currentActive) {
      this.fullRevision += 1;
      this.advanceSessionRevision(sessionId);
      this.writeIds(
        reportedActive
          ? [...this.ids, sessionId]
          : this.ids.filter((id) => id !== sessionId),
      );
    }
    return { active: reportedActive, accepted: true };
  }

  forgetCurrent(sessionId: string): void {
    if (!sessionId) return;
    this.fullRevision += 1;
    this.advanceSessionRevision(sessionId);
    if (this.ids.includes(sessionId))
      this.writeIds(this.ids.filter((id) => id !== sessionId));
  }

  resetForReplacement(): void {
    this.projectionGeneration += 1;
    this.fullRevision += 1;
    this.replaceIds([]);
  }

  private replaceIds(ids: readonly string[]): void {
    const next = normalizedIds(ids);
    const changed = new Set([...this.ids, ...next]);
    for (const id of changed) {
      if (this.ids.includes(id) !== next.includes(id))
        this.advanceSessionRevision(id);
    }
    this.writeIds(next);
  }

  private advanceSessionRevision(sessionId: string): void {
    this.sessionRevisions.set(
      sessionId,
      (this.sessionRevisions.get(sessionId) || 0) + 1,
    );
  }

  private writeIds(ids: readonly string[]): void {
    this.ids = normalizedIds(ids);
    this.sink([...this.ids]);
  }
}
