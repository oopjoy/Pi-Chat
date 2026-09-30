import type { SessionViewData } from "../../shared/types.js";
import { OperationAdmissionClosedError } from "../operation-admission.js";

export class StaleSessionViewRuntimeError extends Error {}

export interface SessionViewServicePorts {
  isPrimary(sessionId: string): boolean;
  secondaryExists(sessionId: string): boolean;
  acquirePrimary(): { generation: number; rpcGeneration: number; release(): void };
  primaryCurrent(sessionId: string, lease: { generation: number; rpcGeneration: number }): boolean;
  acquireSecondary(sessionId: string): { generation: number; rpcGeneration: number; release(): void };
  secondaryCurrent(sessionId: string, lease: { generation: number; rpcGeneration: number }): boolean;
  hotView(sessionId: string, turnLimit: number, clientId: string): SessionViewData | null;
  currentProjection(sessionId: string, turnLimit: number, clientId: string, assertCurrent: () => void): Promise<SessionViewData | null>;
  coldView(sessionId: string, turnLimit: number, clientId: string, includeForkOrigin: boolean): Promise<SessionViewData | null>;
  forkOrigin(sessionId: string): Promise<SessionViewData["forkOrigin"]>;
}

/** Hot/cold view admission with source-Runtime staleness fencing. */
export async function readSessionView(
  ports: SessionViewServicePorts,
  sessionId: string,
  turnLimit: number,
  clientId: string,
  options: { fast?: boolean; includeForkOrigin?: boolean } = {},
): Promise<SessionViewData | null> {
  const primary = ports.isPrimary(sessionId);
  const secondary = !primary && ports.secondaryExists(sessionId);
  if (!primary && !secondary) {
    const view = options.fast
      ? ports.hotView(sessionId, turnLimit, clientId)
      : await ports.currentProjection(sessionId, turnLimit, clientId, () => {});
    if (!view || !options.includeForkOrigin) return view;
    return { ...view, forkOrigin: await ports.forkOrigin(sessionId) };
  }
  let release: (() => void) | null = null;
  let current: () => boolean;
  try {
    if (primary) {
      const lease = ports.acquirePrimary();
      release = lease.release;
      current = () => ports.primaryCurrent(sessionId, lease);
    } else {
      const lease = ports.acquireSecondary(sessionId);
      release = lease.release;
      current = () => ports.secondaryCurrent(sessionId, lease);
    }
  } catch (error) {
    if (!(error instanceof OperationAdmissionClosedError)) throw error;
    return options.fast ? null : ports.coldView(sessionId, turnLimit, clientId, Boolean(options.includeForkOrigin));
  }
  const assertCurrent = () => { if (!current()) throw new StaleSessionViewRuntimeError(); };
  let view: SessionViewData | null = null;
  let stale = false;
  try {
    view = options.fast
      ? ports.hotView(sessionId, turnLimit, clientId)
      : await ports.currentProjection(sessionId, turnLimit, clientId, assertCurrent);
    assertCurrent();
    if (view && options.includeForkOrigin) {
      view = { ...view, forkOrigin: await ports.forkOrigin(sessionId) };
      assertCurrent();
    }
  } catch (error) {
    if (error instanceof StaleSessionViewRuntimeError) stale = true;
    else throw error;
  } finally {
    release?.();
  }
  return stale
    ? options.fast ? null : ports.coldView(sessionId, turnLimit, clientId, Boolean(options.includeForkOrigin))
    : view;
}
