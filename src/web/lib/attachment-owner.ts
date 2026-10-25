import { draftFiles, type ComposerState } from "../state/composer";

const pages = new WeakMap<Document, { owner: string }>();

function pageState(): { owner: string } {
  let state = pages.get(document);
  if (!state) {
    state = { owner: crypto.randomUUID() };
    pages.set(document, state);
  }
  return state;
}

/** Stable per-page owner for managed attachment staging and leases. */
export function attachmentStorageOwner(): string {
  return pageState().owner;
}

/** All currently retained attachment paths across Composer partitions. */
export function composerFileReferences(state: ComposerState): string[] {
  const paths = new Set<string>();
  for (const partition of Object.values(state.partitions)) {
    if (!partition) continue;
    for (const draft of [partition.draft, ...(partition.suspended || []), ...partition.pending,
      ...(partition.inFlight ? [partition.inFlight] : [])])
      for (const path of draftFiles(draft)) paths.add(path);
  }
  return [...paths];
}
