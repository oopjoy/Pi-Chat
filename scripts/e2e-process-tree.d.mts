import type { ChildProcess } from "node:child_process";

export interface ObservedOwnedProcess {
  child: ChildProcess;
  close: {
    confirmed: boolean;
    promise: Promise<void>;
  };
  processGroup: boolean;
}

export function observeOwnedProcess(
  child: ChildProcess,
  processGroup?: boolean,
): ObservedOwnedProcess;

export function waitForOwnedProcessClose(
  observed: ObservedOwnedProcess,
  timeoutMs: number,
): Promise<boolean>;

export function requireSuccessfulTaskkill(
  code: number | null,
  pid: number,
): void;

export function waitForOwnedProcessTreeExit(
  observed: ObservedOwnedProcess,
  timeoutMs: number,
): Promise<boolean>;

export function terminateOwnedProcessTree(
  observed: ObservedOwnedProcess,
  timeoutMs?: number,
): Promise<void>;
