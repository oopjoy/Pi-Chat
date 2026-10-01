import type { BootstrapData, SessionDirectorySummary, SessionSummary } from "../../shared/types.js";
type SessionIndex = any;

export function createSidebarProjectionActions(host: Record<string, any>) {
  const {
    DEFAULT_DIRECTORY_SESSION_LIST_SIZE,
    DEFAULT_SESSION_LIST_SIZE,
    compareSessionsByLastUserPrompt,
    resolve,
  } = host;
  function sessionSummaries(
    sessions: BootstrapData["sessions"],
    clientId = "",
  ): BootstrapData["sessions"] {
    // Empty drafts stay out of the sidebar. Prompted drafts that SessionIndex has
    // not yet scanned must still appear as soon as the first send is accepted.
    const listed = sessions.map((session: any) => {
      const runtime = host.runtimePool.get(session.id);
      const lastUserPromptAt =
        host.lastUserPromptAtBySession.get(session.id) ??
        runtime?.lastUserPromptAt ??
        session.lastUserPromptAt;
      return {
        ...session,
        ...(runtime?.cwd ? { cwd: runtime.cwd } : null),
        ...(lastUserPromptAt !== undefined ? { lastUserPromptAt } : null),
        writable: host.activeSessionIds().includes(session.id),
        running:
          (session.id === host.activeSessionId && host.primaryTurnActive()) ||
          Boolean(runtime && host.runtimeTurnActive(runtime)),
        queued:
          session.id === host.activeSessionId
            ? host.promptQueue.length > 0
            : (runtime?.promptQueue.length || 0) > 0,
        pendingConfirmation: Boolean(host.pendingRequestForSession(session.id)),
        activity: host.sessionActivity(session.id),
        ...host.controlState(session.id, clientId),
      };
    });
    const known = new Set(listed.map((session: any) => session.id));
    for (const runtime of host.runtimePool.runtimes.values()) {
      if (known.has(runtime.id)) continue;
      if (
        !runtime.prompted &&
        !host.runtimeTurnActive(runtime) &&
        !runtime.dispatching
      )
        continue;
      // A persisted Session may be momentarily absent from a refresh while its
      // JSONL is being written. Its Runtime captured the indexed summary at
      // activation; use that before the one-message draft fallback so a real
      // title/count cannot regress to "新会话" in the sidebar.
      const base = runtime.summarySnapshot ||
        runtime.draftSession || {
          id: runtime.id,
          sessionId: runtime.id,
          name: "新会话",
          preview: "新会话",
          cwd: runtime.cwd,
          updatedAt: runtime.lastUsedAt,
          messageCount: 1,
          active: true,
        };
      listed.push({
        ...base,
        messageCount: Math.max(base.messageCount || 0, 1),
        updatedAt: Math.max(base.updatedAt || 0, runtime.lastUsedAt),
        lastUserPromptAt:
          host.lastUserPromptAtBySession.get(runtime.id) ??
          runtime.lastUserPromptAt ??
          base.lastUserPromptAt ??
          base.updatedAt,
        active: true,
        writable: true,
        running:
          host.runtimeTurnActive(runtime) || runtime.dispatching,
        queued: runtime.promptQueue.length > 0,
        pendingConfirmation: Boolean(host.pendingRequestForSession(runtime.id)),
        activity: host.sessionActivity(runtime.id),
        ...host.controlState(runtime.id, clientId),
      });
      known.add(runtime.id);
    }
    return listed.sort(compareSessionsByLastUserPrompt);
  }

  function sidebarSessions(
    sessions: SessionSummary[],
    clientId: string,
    all = false,
    includeIds: readonly string[] = [],
  ): {
    sessions: SessionSummary[];
    total: number;
    directories: SessionDirectorySummary[];
  } {
    const enriched = host.sessionSummaries(sessions, clientId);
    const groups = new Map<string, SessionSummary[]>();
    for (const session of enriched) {
      const key = session.cwd || "";
      const group = groups.get(key);
      if (group) group.push(session);
      else groups.set(key, [session]);
    }
    const directories = [...groups.entries()]
      .map(([cwd, group]: any) => ({
        cwd,
        count: group.length,
        lastUserPromptAt:
          group[0]?.lastUserPromptAt ?? group[0]?.updatedAt ?? 0,
      }))
      .sort((left: any, right: any) => right.lastUserPromptAt - left.lastUserPromptAt);
    if (all) return { sessions: enriched, total: enriched.length, directories };
    const cwdKey = (cwd: string) =>
      cwd ? resolve(cwd).toLowerCase() : "__unknown_cwd__";
    const current =
      [...groups.entries()].find(
        ([cwd]: any) => cwdKey(cwd) === cwdKey(host.currentCwd),
      )?.[1] || [];
    const selected = current.slice(0, DEFAULT_DIRECTORY_SESSION_LIST_SIZE);
    for (const directory of directories) {
      if (selected.length >= DEFAULT_SESSION_LIST_SIZE) break;
      if (cwdKey(directory.cwd) === cwdKey(host.currentCwd)) continue;
      selected.push(
        ...(groups.get(directory.cwd) || []).slice(
          0,
          Math.min(
            DEFAULT_DIRECTORY_SESSION_LIST_SIZE,
            DEFAULT_SESSION_LIST_SIZE - selected.length,
          ),
        ),
      );
    }
    // Pins are browser-local presentation preferences. The read-only inventory
    // endpoint may request their bounded stable IDs so an older pinned Session
    // remains visible without forcing an unbounded all=1 scan into every page.
    if (includeIds.length) {
      const selectedIds = new Set(selected.map((session: any) => session.id));
      const requested = new Set(includeIds);
      for (const session of enriched) {
        if (!requested.has(session.id) || selectedIds.has(session.id)) continue;
        selected.push(session);
        selectedIds.add(session.id);
      }
    }
    return { sessions: selected, total: enriched.length, directories };
  }

  function cachedSessionList(activePath?: string): Promise<SessionSummary[]> {
    const cached = (
      host.options.sessions as SessionIndex & {
        listCached?: (
          activePath?: string,
          cwd?: string,
        ) => Promise<SessionSummary[]>;
      }
    ).listCached;
    return cached
      ? cached.call(host.options.sessions, activePath)
      : host.options.sessions.list(activePath);
  }


  return {
    sessionSummaries,
    sidebarSessions,
    cachedSessionList,
  };
}
