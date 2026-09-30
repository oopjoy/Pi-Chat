import type { IncomingMessage, ServerResponse } from "node:http";
import type { InitialPromptData, PromptSettingsSnapshot, SessionViewData } from "../../shared/types.js";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";
import { PROMPT_BODY_LIMIT } from "../api-route-admission.js";
import { PrimaryRuntimeUnavailableError } from "../primary-runtime-readiness.js";
import type { DraftRuntimeLease } from "../runtime-pool.js";
import { parseNewSessionInput } from "./new-session-input.js";
import { prepareNewDraftRuntime } from "../services/new-draft-preparation.js";

export interface NewSessionRouteHost {
  currentCwd(): string;
  primaryNeedsRecovery(): boolean;
  waitForPrimaryCompatibility(): Promise<void>;
  acquireDraft(clientId: string, cwd: string): Promise<DraftRuntimeLease>;
  rethrowResultPending(error: unknown, operation: string): never;
  markViewed(clientId: string, sessionId: string): void;
  draftView(runtime: DraftRuntimeLease["runtime"], clientId: string): Promise<SessionViewData>;
  beginPromptAdmission(sessionId: string): Promise<() => void>;
  firstTurn(runtime: DraftRuntimeLease["runtime"], input: {
    message: string;
    images: import("../../shared/types.js").PromptImage[];
    gateMode?: import("../../shared/types.js").GateMode;
    clientPromptOperationId: string;
    settings?: PromptSettingsSnapshot;
  }, clientId: string): Promise<InitialPromptData>;
  discardDraft(runtime: DraftRuntimeLease["runtime"]): Promise<void>;
}

/** New-draft route owns HTTP/lease sequencing; Runtime effects stay in App ports. */
export async function handleNewSessionRoute(
  host: NewSessionRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  clientId: string,
  preparedBody?: Record<string, unknown>,
): Promise<boolean> {
  if (url.pathname !== "/api/sessions/new") return false;
  if (request.method !== "POST") { methodNotAllowed(response); return true; }
  const body = preparedBody || await bodyJson(request, PROMPT_BODY_LIMIT);
  const parsed = await parseNewSessionInput(body, host.currentCwd());
  if (parsed.kind === "error") {
    json(response, parsed.status, { error: parsed.error });
    return true;
  }
  const preparation = await prepareNewDraftRuntime({
    primaryNeedsRecovery: () => host.primaryNeedsRecovery(),
    waitForPrimaryCompatibility: () => host.waitForPrimaryCompatibility(),
    acquireDraft: (owner, cwd) => host.acquireDraft(owner, cwd),
    rethrowResultPending: (error, operation) => host.rethrowResultPending(error, operation),
    markViewed: (owner, sessionId) => host.markViewed(owner, sessionId),
  }, { clientId, cwd: parsed.cwd });
  const { lease } = preparation;
  try {
    if (!parsed.initial) {
      json(response, 200, await host.draftView(lease.runtime, clientId));
      return true;
    }
    const releasePromptAdmission = await host.beginPromptAdmission(lease.runtime.id);
    try {
      const result = await host.firstTurn(lease.runtime, {
        message: parsed.message,
        images: parsed.images,
        gateMode: parsed.gateMode,
        clientPromptOperationId: parsed.clientPromptOperationId,
        settings: {
          ...(parsed.initial?.model ? { model: parsed.initial.model } : null),
          ...(parsed.initial?.thinkingLevel ? { thinkingLevel: parsed.initial.thinkingLevel } : null),
        },
      }, clientId);
      json(response, 202, result);
    } finally {
      releasePromptAdmission();
    }
  } catch (error) {
    if (lease.created && error instanceof PrimaryRuntimeUnavailableError) {
      lease.release();
      await host.discardDraft(lease.runtime).catch(() => undefined);
    }
    throw error;
  } finally {
    lease.release();
  }
  return true;
}
