import type { SessionSummary, SessionViewData } from "../../shared/types.js";
import type { SessionFileSnapshot, SessionIndex } from "../session-index.js";

export interface ColdSessionViewPorts {
  index: SessionIndex;
  activeSessionPath(): string | undefined;
  currentCwd(): string;
  projectSnapshot(id: string, session: SessionSummary, snapshot: SessionFileSnapshot, turnLimit: number, clientId: string): SessionViewData;
  projectMessages(id: string, session: SessionSummary, turnLimit: number, clientId: string): Promise<SessionViewData | null>;
  forkOrigin(id: string): Promise<SessionViewData["forkOrigin"]>;
}

/** Target-only cold Session read orchestration; SessionIndex remains authority. */
export async function readColdSessionView(
  ports: ColdSessionViewPorts,
  id: string,
  turnLimit: number,
  clientId: string,
  includeForkOrigin = false,
): Promise<SessionViewData | null> {
  const index = ports.index as SessionIndex & {
    cachedSummaryForId?: (sessionId: string) => Promise<SessionSummary | null>;
    snapshotAndSummaryForId?: (sessionId: string) => Promise<{ snapshot: SessionFileSnapshot; summary: SessionSummary } | null>;
    recentSnapshotAndSummaryForId?: (sessionId: string, turnLimit: number) => Promise<{ snapshot: SessionFileSnapshot; summary: SessionSummary } | null>;
  };
  let recentTarget: { snapshot: SessionFileSnapshot; summary: SessionSummary } | null = null;
  if (index.recentSnapshotAndSummaryForId) {
    try { recentTarget = await index.recentSnapshotAndSummaryForId(id, turnLimit); }
    catch { recentTarget = null; }
  }
  let target = recentTarget;
  if (!target && index.snapshotAndSummaryForId) {
    // The full path is a compatibility fallback for older embedding hosts.
    // A current oversized JSONL may intentionally have no materializable full
    // snapshot, so never let that fallback re-surface the 128 MiB error.
    try { target = await index.snapshotAndSummaryForId(id); }
    catch { target = null; }
  }
  let view = target
    ? ports.projectSnapshot(id, target.summary, target.snapshot, turnLimit, clientId)
    : null;
  if (!view) {
    let knownSession = await index.cachedSummaryForId?.(id) || ports.index.summaryForId?.(id);
    if (!knownSession)
      knownSession = (await ports.index.list(ports.activeSessionPath(), ports.currentCwd()))
        .find((session) => session.id === id) || null;
    view = knownSession
      ? await ports.projectMessages(id, knownSession, turnLimit, clientId)
      : null;
  }
  if (!view || !includeForkOrigin) return view;
  return { ...view, forkOrigin: await ports.forkOrigin(id) };
}
