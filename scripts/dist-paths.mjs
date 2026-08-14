import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export class UnsafeDistTargetError extends Error {}

function pathKey(path) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(base, target) {
  const fromBase = relative(base, target);
  return fromBase !== "" && fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase);
}

function nearestExistingAncestor(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function canonicalExistingAncestor(path) {
  const ancestor = nearestExistingAncestor(path);
  return realpathSync.native ? realpathSync.native(ancestor) : realpathSync(ancestor);
}

function firstRelativeSegment(base, target) {
  return relative(base, target).split(sep)[0] || "";
}

function assertNoForeignGitRoot(projectRoot, target, allowedRoot) {
  let current = nearestExistingAncestor(target);
  const projectKey = pathKey(projectRoot);
  const stopKey = pathKey(allowedRoot);
  while (true) {
    const currentKey = pathKey(current);
    if (currentKey !== projectKey && existsSync(join(current, ".git"))) {
      throw new UnsafeDistTargetError(
        `PI_CHAT_DIST_DIR cannot target another Git worktree: ${target}`,
      );
    }
    if (currentKey === stopKey) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function validateDistTarget({
  projectRoot,
  requested = "dist",
  temporaryRoot = tmpdir(),
}) {
  const root = resolve(projectRoot);
  const target = resolve(root, requested || "dist");
  const liveDist = resolve(root, "dist");
  const tempRoot = resolve(temporaryRoot);
  const targetKey = pathKey(target);
  const rootKey = pathKey(root);
  const liveKey = pathKey(liveDist);
  const tempKey = pathKey(tempRoot);

  if (targetKey === rootKey) {
    throw new UnsafeDistTargetError("PI_CHAT_DIST_DIR cannot be the repository root");
  }
  if (dirname(target) === target) {
    throw new UnsafeDistTargetError("PI_CHAT_DIST_DIR cannot be a filesystem root");
  }

  let kind;
  let allowedRoot;
  if (targetKey === liveKey) {
    kind = "live";
    allowedRoot = root;
  } else if (isWithin(root, target)) {
    const first = firstRelativeSegment(root, target);
    if (first === "dist-local" || /^\.pi-chat-[A-Za-z0-9._-]+$/.test(first)) {
      kind = "repository-stage";
      allowedRoot = root;
    } else {
      throw new UnsafeDistTargetError(
        `PI_CHAT_DIST_DIR must use dist, dist-local/, a controlled .pi-chat-* stage, or the OS temp directory: ${target}`,
      );
    }
  } else if (targetKey !== tempKey && isWithin(tempRoot, target)) {
    kind = "temporary-stage";
    allowedRoot = tempRoot;
  } else {
    throw new UnsafeDistTargetError(
      `PI_CHAT_DIST_DIR is outside approved build roots: ${target}`,
    );
  }

  const canonicalAllowed = canonicalExistingAncestor(allowedRoot);
  const canonicalTargetAncestor = canonicalExistingAncestor(target);
  const canonicalAllowedKey = pathKey(canonicalAllowed);
  const canonicalTargetKey = pathKey(canonicalTargetAncestor);
  if (
    canonicalTargetKey !== canonicalAllowedKey &&
    !isWithin(canonicalAllowed, canonicalTargetAncestor)
  ) {
    throw new UnsafeDistTargetError(
      `PI_CHAT_DIST_DIR escapes its approved root through a filesystem link: ${target}`,
    );
  }

  // Inspect both spellings. The lexical walk rejects a direct foreign worktree
  // target, while the canonical walk catches a junction into a descendant of a
  // different worktree that still sits inside the approved repository/temp root.
  assertNoForeignGitRoot(root, target, allowedRoot);
  assertNoForeignGitRoot(canonicalAllowed, canonicalTargetAncestor, canonicalAllowed);
  return { target, kind };
}
