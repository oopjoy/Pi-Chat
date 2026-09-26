export const LOCAL_FILE_LINK_FRAGMENT_PREFIX = "#pi-chat-local:";
const MAX_LOCAL_LINK_CHARS = 4_096;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function decodeOnce(value: string): string | null {
  if (!value || value.length > MAX_LOCAL_LINK_CHARS) return null;
  try { return decodeURIComponent(value); }
  catch { return null; }
}

function fileUriPath(value: string): string | null {
  if (!/^file:/i.test(value)) return null;
  let url: URL;
  try { url = new URL(value); }
  catch { return null; }
  if (
    (url.hostname && url.hostname.toLowerCase() !== "localhost")
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
  ) return null;
  const pathname = decodeOnce(url.pathname);
  if (!pathname) return null;
  const drivePath = /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  return WINDOWS_DRIVE_PATH.test(drivePath)
    ? drivePath.replace(/\//g, "\\")
    : null;
}

/** Decode a Markdown destination that names a Windows file, not a Web URL. */
export function windowsPathFromMarkdownDestination(value: string): string | null {
  const decoded = decodeOnce(value.trim());
  if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  const fromUri = fileUriPath(decoded);
  if (fromUri) return fromUri;
  if (WINDOWS_DRIVE_PATH.test(decoded)) return decoded.replace(/\//g, "\\");
  if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(decoded))
    return decoded.replace(/\//g, "\\");
  return null;
}

function relativeDestination(value: string): string | null {
  const decoded = decodeOnce(value.trim());
  if (
    !decoded
    || decoded.startsWith("#")
    || decoded.startsWith("?")
    || decoded.startsWith("/")
    || decoded.startsWith("\\")
    || URI_SCHEME.test(decoded)
    || /[\u0000-\u001f\u007f]/.test(decoded)
  ) return null;
  const parts = decoded.replace(/\\/g, "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

export function encodeLocalFileMarkdownDestination(value: string): string {
  return `${LOCAL_FILE_LINK_FRAGMENT_PREFIX}${encodeURIComponent(value)}`;
}

/** Whether ReactMarkdown should route this destination through Pi Chat. */
export function isLocalFileMarkdownDestination(value: string): boolean {
  return windowsPathFromMarkdownDestination(value) !== null
    || relativeDestination(value) !== null;
}

/**
 * Convert a rendered local-file destination into a browser advisory relative
 * path. The server independently resolves it against the addressed Session.
 */
export function workspaceRelativePathFromMarkdownDestination(
  value: string,
  workspaceCwd: string,
): string | null {
  const relative = relativeDestination(value);
  if (relative) return relative;
  const target = windowsPathFromMarkdownDestination(value);
  if (!target || !workspaceCwd) return null;
  const workspace = workspaceCwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const candidate = target.replace(/\\/g, "/");
  const caseInsensitive = WINDOWS_DRIVE_PATH.test(workspace) || workspace.startsWith("//");
  const comparedWorkspace = caseInsensitive ? workspace.toLowerCase() : workspace;
  const comparedCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  if (!comparedCandidate.startsWith(`${comparedWorkspace}/`)) return null;
  return relativeDestination(candidate.slice(workspace.length + 1));
}
