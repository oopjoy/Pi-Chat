import type { ExtensionUiRequest, GateMode } from "../../shared/types";
import type { PaneAuthoritySnapshot } from "./pane-authority";
import type { ConversationPaneAction } from "../state/conversation-pane";
import { gateModeFromNotice } from "../lib/gate-mode";

export interface ExtensionStreamEffectHost {
  setSessionPending(sessionId: string, pending: boolean): void;
  patchSessionRequest(sessionId: string, request: ExtensionUiRequest | undefined): void;
  captureAuthority(sessionId: string): PaneAuthoritySnapshot | null;
  tryAutoAllowGate(request: ExtensionUiRequest, sessionId: string, authority: PaneAuthoritySnapshot, force: boolean): boolean;
  dispatchPane(action: ConversationPaneAction): void;
  updateGateMode(sessionId: string, mode: GateMode): void;
  clearPendingGate(sessionId: string): void;
  showNotice(message: string): void;
}

/** Apply Extension UI request/notification effects through explicit App ports. */
export function applyExtensionUiRequestEffect(
  request: ExtensionUiRequest,
  sessionId: string,
  viewing: boolean,
  host: ExtensionStreamEffectHost,
): void {
  if (["select", "confirm", "input", "editor"].includes(request.method)) {
    host.setSessionPending(sessionId, true);
    host.patchSessionRequest(sessionId, request);
    if (viewing) {
      const authority = host.captureAuthority(sessionId);
      if (!authority || !host.tryAutoAllowGate(request, sessionId, authority, true))
        host.dispatchPane({ type: "EXTENSION_REQUEST_CHANGED", sessionId, request });
    }
    return;
  }
  if (request.method === "notify") {
    const mode = gateModeFromNotice(request.message);
    if (mode) {
      host.updateGateMode(sessionId, mode);
      host.clearPendingGate(sessionId);
    }
    if (viewing) host.showNotice(request.message || "Pi 通知");
  }
}
