import type { SessionDirectorySummary, SessionSummary } from "../../shared/types";

const MAX_PINNED_IDS = 500;
const MAX_DIRECTORY_KEY_LENGTH = 1_000;

export interface SessionNavigationGroup {
  key: string;
  label: string;
  sessions: SessionSummary[];
  total: number;
  fixed: boolean;
  collapsed: boolean;
  pinnable: boolean;
}

export function orderedPinnedSessionIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const unique = new Set<string>();
  for (const value of ids) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id)) continue;
    unique.add(id);
    if (unique.size >= MAX_PINNED_IDS) break;
  }
  return [...unique];
}

/** Browser-only stable cwd key; no filesystem resolution is attempted. */
export function normalizeCwdKey(cwd: unknown): string {
  if (typeof cwd !== "string") return "";
  let normalized = cwd.trim().replace(/[\u0000-\u001f]/g, "").replace(/\\/g, "/");
  if (!normalized || normalized.length > MAX_DIRECTORY_KEY_LENGTH) return "";
  const unc = normalized.startsWith("//");
  normalized = unc
    ? `//${normalized.slice(2).replace(/\/{2,}/g, "/")}`
    : normalized.replace(/\/{2,}/g, "/");
  const root = normalized === "/" || /^[A-Za-z]:\/$/.test(normalized);
  if (!root) normalized = normalized.replace(/\/+$/, "");
  if (!normalized) return "";
  return /^([A-Za-z]:\/|\/\/)/.test(normalized)
    ? normalized.toLocaleLowerCase()
    : normalized;
}

export function directoryLabel(cwd: unknown): string {
  const key = normalizeCwdKey(cwd);
  return key || "未记录工作目录";
}

export function orderedPinnedDirectoryKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const unique = new Set<string>();
  for (const value of keys) {
    const key = normalizeCwdKey(value);
    if (!key) continue;
    unique.add(key);
    if (unique.size >= MAX_PINNED_IDS) break;
  }
  return [...unique];
}

export function togglePinnedSession(ids: string[], sessionId: string): string[] {
  return ids.includes(sessionId)
    ? ids.filter((id) => id !== sessionId)
    : [sessionId, ...ids.filter((id) => id !== sessionId)];
}

export function togglePinnedDirectory(keys: string[], cwd: string): string[] {
  const key = normalizeCwdKey(cwd);
  if (!key) return keys;
  return keys.includes(key)
    ? keys.filter((value) => value !== key)
    : [key, ...keys.filter((value) => value !== key)];
}

export function toggleCollapsedDirectory(keys: string[], cwd: string): string[] {
  const key = normalizeCwdKey(cwd);
  if (!key) return keys;
  return keys.includes(key)
    ? keys.filter((value) => value !== key)
    : [...keys, key];
}

export function orderSessionsByPins(
  sessions: SessionSummary[],
  pinnedSessionIds: string[],
): SessionSummary[] {
  const pinOrder = new Map(pinnedSessionIds.map((sessionId, index) => [sessionId, index]));
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const leftPin = pinOrder.get(left.session.id);
      const rightPin = pinOrder.get(right.session.id);
      if (leftPin !== undefined && rightPin !== undefined) return leftPin - rightPin;
      if (leftPin !== undefined) return -1;
      if (rightPin !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ session }) => session);
}

export function filterSessionsBySearch(sessions: SessionSummary[], query: string): SessionSummary[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return sessions;
  return sessions.filter((session) =>
    [session.name, session.preview, normalizeCwdKey(session.cwd)].some((value) =>
      value.toLocaleLowerCase().includes(normalized),
    ),
  );
}

/** Directory order is outermost; session pins affect only rows inside their directory. */
export function groupSessionsForNavigation(
  sessions: SessionSummary[],
  pinnedSessionIds: string[],
  pinnedDirectoryKeys: string[],
  collapsedDirectoryKeys: string[],
  searchQuery = "",
  directories: SessionDirectorySummary[] = [],
  currentCwd = "",
  expandedDirectoryKeys: string[] = [],
): SessionNavigationGroup[] {
  const searching = Boolean(searchQuery.trim());
  const source = filterSessionsBySearch(sessions, searchQuery);
  const groups = new Map<string, { key: string; label: string; sessions: SessionSummary[]; total: number; lastUserPromptAt: number; index: number }>();
  for (const [index, directory] of directories.entries()) {
    const key = normalizeCwdKey(directory.cwd);
    if (!key) continue;
    groups.set(key, { key, label: directoryLabel(directory.cwd), sessions: [], total: directory.count, lastUserPromptAt: directory.lastUserPromptAt, index });
  }
  for (const [index, session] of source.entries()) {
    const key = normalizeCwdKey(session.cwd);
    const groupKey = key || "__unknown_cwd__";
    const existing = groups.get(groupKey);
    if (existing) {
      existing.sessions.push(session);
      existing.lastUserPromptAt = Math.max(existing.lastUserPromptAt, session.lastUserPromptAt ?? session.updatedAt);
    } else groups.set(groupKey, { key: groupKey, label: directoryLabel(session.cwd), sessions: [session], total: 1, lastUserPromptAt: session.lastUserPromptAt ?? session.updatedAt, index: directories.length + index });
  }
  const directoryOrder = new Map(orderedPinnedDirectoryKeys(pinnedDirectoryKeys).map((key, index) => [key, index]));
  const collapsed = new Set(orderedPinnedDirectoryKeys(collapsedDirectoryKeys));
  const expanded = new Set(orderedPinnedDirectoryKeys(expandedDirectoryKeys));
  const currentKey = normalizeCwdKey(currentCwd);
  return [...groups.values()]
    .filter((group) => !searching || group.sessions.length > 0)
    .sort((left, right) => {
      const leftPin = directoryOrder.get(left.key);
      const rightPin = directoryOrder.get(right.key);
      if (leftPin !== undefined && rightPin !== undefined) return leftPin - rightPin;
      if (leftPin !== undefined) return -1;
      if (rightPin !== undefined) return 1;
      if (left.key === currentKey) return -1;
      if (right.key === currentKey) return 1;
      return right.lastUserPromptAt - left.lastUserPromptAt || left.index - right.index;
    })
    .map((group) => ({
      key: group.key,
      label: group.label,
      sessions: orderSessionsByPins(group.sessions, pinnedSessionIds),
      total: group.total,
      fixed: directoryOrder.has(group.key),
      collapsed: !searching && (collapsed.has(group.key) || (group.key !== currentKey && !expanded.has(group.key))),
      pinnable: group.key !== "__unknown_cwd__",
    }));
}
