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
  const recentTarget = index.recentSnapshotAndSummaryForId
    ? await index.recentSnapshotAndSummaryForId(id, turnLimit)
    : null;
  const target = recentTarget || await index.snapshotAndSummaryForId?.(id);
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
