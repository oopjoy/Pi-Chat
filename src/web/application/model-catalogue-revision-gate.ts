export type ModelCatalogueAuthority = {
  modelCatalogueGeneration: number;
  modelCatalogueProcessGeneration: number;
};

function revisionFrom(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

/**
 * Orders process-local model catalogue snapshots without owning their UI state.
 * SSE may refine one server revision more than once; an HTTP snapshot at that
 * same revision therefore also needs the observation generation captured when
 * its request began.
 */
export class ModelCatalogueRevisionGate {
  private revision = 0;
  private generation = 0;
  private processGeneration = 0;

  captureAuthority(): ModelCatalogueAuthority {
    return {
      modelCatalogueGeneration: this.generation,
      modelCatalogueProcessGeneration: this.processGeneration,
    };
  }

  admitBootstrap(
    value: unknown,
    authority?: ModelCatalogueAuthority,
  ): boolean {
    const revision = revisionFrom(value);
    if (value !== undefined && revision === null) return false;

    if (authority) {
      if (
        authority.modelCatalogueProcessGeneration !== this.processGeneration
      ) return false;
      if (revision !== null) {
        if (revision < this.revision) return false;
        if (
          revision === this.revision &&
          authority.modelCatalogueGeneration !== this.generation
        ) return false;
      } else if (
        this.revision > 0 ||
        authority.modelCatalogueGeneration !== this.generation
      ) return false;
    } else {
      // Mutation responses have no request authority in App. Once revisioned
      // state exists, only a strictly newer response may beat ordered SSE.
      if (revision === null) {
        if (this.revision > 0) return false;
      } else if (revision <= this.revision) return false;
    }

    if (revision !== null) this.revision = revision;
    this.generation += 1;
    return true;
  }

  admitSse(value: unknown): boolean {
    const revision = revisionFrom(value);
    if (value !== undefined && revision === null) return false;
    if (revision === null) {
      if (this.revision > 0) return false;
    } else {
      if (revision < this.revision) return false;
      this.revision = revision;
    }
    // Equal revisions are meaningful: host discovery may be followed by a
    // Runtime-synchronized refinement under the same server revision.
    this.generation += 1;
    return true;
  }

  resetForProcessReplacement(): void {
    this.revision = 0;
    this.generation += 1;
    this.processGeneration += 1;
  }
}
