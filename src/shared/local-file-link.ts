export const LOCAL_FILE_LINK_FRAGMENT_PREFIX = "#pi-chat-local:";
export const LOCAL_FILE_IMAGE_FRAGMENT_PREFIX = "#pi-chat-local-image:";
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

/** Marker form for local image sources; the img renderer resolves it per Session. */
export function encodeLocalFileImageDestination(value: string): string {
  return `${LOCAL_FILE_IMAGE_FRAGMENT_PREFIX}${encodeURIComponent(value)}`;
}

/** Whether ReactMarkdown should route this destination through Pi Chat. */
export function isLocalFileMarkdownDestination(value: string): boolean {
  return windowsPathFromMarkdownDestination(value) !== null
    || relativeDestination(value) !== null
    || posixPathFromMarkdownDestination(value) !== null;
}

function posixPathFromMarkdownDestination(value: string): string | null {
  const decoded = decodeOnce(value.trim());
  return decoded?.startsWith("/") && !decoded.startsWith("//") ? decoded : null;
}

/** Lexical normalization only; this does not grant filesystem access. No decoding here. */
export function normalizeLocalFileReference(value: string): string | null {
  if (!value || value.length > MAX_LOCAL_LINK_CHARS || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const candidate = value.replace(/\\/g, "/");
  if (candidate.startsWith("//")) return null; // No new UNC/device/network authority.
  const drive = /^[A-Za-z]:\//.test(candidate);
  const prefix = drive ? `${candidate[0]!.toUpperCase()}:/` : candidate.startsWith("/") ? "/" : "";
  const tail = candidate.slice(prefix.length).replace(/\/+$/, "");
  const parts = tail.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return null;
  return `${prefix}${parts.join("/")}`;
}

/**
 * Advisory reference for an explicitly linked file/image. Keep in-workspace paths
 * relative, but retain local absolute paths outside it. The server must match the
 * reference against persisted assistant Markdown before resolving any target.
 */
export function localFileReferenceFromMarkdownDestination(value: string, workspaceCwd: string): string | null {
  const relative = workspaceRelativePathFromMarkdownDestination(value, workspaceCwd);
  if (relative) return normalizeLocalFileReference(relative);
  const absolute = windowsPathFromMarkdownDestination(value) || posixPathFromMarkdownDestination(value);
  if (!absolute) return null;
  // POSIX absolute paths are not drive-relative paths on a Windows host.
  if (absolute.startsWith("/") && /^[A-Za-z]:[\\/]/.test(workspaceCwd)) return null;
  const workspace = workspaceCwd.replace(/\/+$/, "");
  if (absolute.startsWith("/") && workspaceCwd.startsWith("/") && absolute.startsWith(`${workspace}/`))
    return normalizeLocalFileReference(absolute.slice(workspace.length + 1));
  return normalizeLocalFileReference(absolute);
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
