import { lstatSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { UnsafeDistTargetError, validateDistTarget } from "./dist-paths.mjs";

export class UnsafeE2eRootError extends Error {}

export function validateE2eRoot({ projectRoot, requested }) {
  let validated;
  try {
    validated = validateDistTarget({ projectRoot, requested });
  } catch (error) {
    if (error instanceof UnsafeDistTargetError)
      throw new UnsafeE2eRootError(error.message, { cause: error });
    throw error;
  }
  const targetKey = process.platform === "win32"
    ? validated.target.toLowerCase()
    : validated.target;
  const temporaryRoot = resolve(tmpdir());
  const temporaryKey = process.platform === "win32"
    ? temporaryRoot.toLowerCase()
    : temporaryRoot;
  if (
    validated.kind !== "temporary-stage" ||
    (process.platform === "win32"
      ? dirname(validated.target).toLowerCase()
      : dirname(validated.target)) !== temporaryKey ||
    !/^pi-chat-e2e-root-[A-Za-z0-9]{6}$/.test(basename(targetKey))
  ) {
    throw new UnsafeE2eRootError(
      `E2E root must be a fresh direct OS-temp child named pi-chat-e2e-root-XXXXXX: ${validated.target}`,
    );
  }
  let stat;
  try {
    stat = lstatSync(validated.target);
  } catch (error) {
    throw new UnsafeE2eRootError(
      `E2E root must already exist as a caller-created directory: ${validated.target}`,
      { cause: error },
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UnsafeE2eRootError(
      `E2E root must be a real caller-created directory: ${validated.target}`,
    );
  }
  if (readdirSync(validated.target).length !== 0) {
    throw new UnsafeE2eRootError(
      `E2E root must be empty before the server starts: ${validated.target}`,
    );
  }
  return validated.target;
}

export function combinedE2eError(primaryError, secondaryErrors, message) {
  const errors = primaryError === undefined
    ? secondaryErrors
    : [primaryError, ...secondaryErrors];
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AggregateError(
    errors,
    message,
    primaryError === undefined ? undefined : { cause: primaryError },
  );
}

export async function removeE2eRootAfterConfirmedTree(
  root,
  treeExitConfirmed,
  remove = (path) => rm(path, { recursive: true, force: true }),
) {
  if (!treeExitConfirmed) {
    throw new Error(`E2E process tree exit is unconfirmed; retained root: ${root}`);
  }
  await remove(root);
}
