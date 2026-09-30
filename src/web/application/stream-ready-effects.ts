import { api } from "../api";
import { lifecycleFromEvent, parseEventData } from "../lib/pi-events";
import type { PrimaryRuntimeReadiness } from "../../shared/types";

/** Translate the SSE ready frame without owning transport or lifecycle state. */
export function createStreamReadyHandler(host: Record<string, any>) {
  return (rawEvent: Event, source: EventSource): void => {
    host.noteEventFrame();
    if (document.visibilityState !== "hidden" && document.hasFocus())
      void api.renewPresence().catch(() => undefined);
    const ready = parseEventData(rawEvent);
    if (!ready) {
      host.rejectSse({ eventType: "unknown", decisionReason: "malformed-json" });
      return;
    }
    const readyLifecycle = lifecycleFromEvent(ready);
    if (!readyLifecycle) {
      host.rejectSse({ eventType: "ready", decisionReason: "malformed-lifecycle" });
      return;
    }
    const readyRunEpoch = typeof ready.piChatRunEpoch === "string" ? ready.piChatRunEpoch : "";
    const serverEpochChanged = Boolean(readyRunEpoch && host.runEpoch() && readyRunEpoch !== host.runEpoch());
    if (serverEpochChanged) {
      host.resetBootstrapRecovery();
      host.advanceRunEpochGeneration();
      host.cancelPendingNavigation();
      host.detachSessionRefreshWork();
      host.detachBootstrapAndHandshake();
      host.resetDraftPickers();
      host.resetRefreshState();
      host.clearStopping();
      host.resetProcessOwnedUiState();
      host.resetSidebarInventory();
      host.resetRuntimeProjection();
      host.resetActiveSessionProjection();
      host.resetModelCatalogue();
      host.resetWorkspaceEpoch(readyRunEpoch);
    } else if (readyRunEpoch && !host.runEpoch()) host.setRunEpoch(readyRunEpoch);

    const readyPrimary = ready.primaryRuntime as Partial<PrimaryRuntimeReadiness> | undefined;
    const currentReadiness = host.currentReadiness();
    const readyNeedsMetadataRefresh = readyPrimary?.status === "ready"
      && typeof readyPrimary.generation === "number"
      && !readyPrimary.model
      && (currentReadiness.status !== "ready" || currentReadiness.generation !== readyPrimary.generation);
    if (readyPrimary && ["starting", "ready", "failed"].includes(readyPrimary.status || "") && typeof readyPrimary.generation === "number") {
      const incoming = readyPrimary as PrimaryRuntimeReadiness;
      const next = host.observeTransportReady(incoming);
      if (next.status === "ready" && next.generation === incoming.generation && incoming.status === "ready" && next.model) {
        host.rememberObservedModel(next.model);
        const target = host.localDraft() ? { kind: "draft" as const } : next.sessionId ? { kind: "session" as const, sessionId: next.sessionId } : { kind: "draft" as const };
        host.publishReadyCapability({ generation: next.generation, modelKeys: [host.modelCapabilityKey(next.model)].filter(Boolean) });
        host.dispatchPane({ type: "RUNTIME_SETTINGS_ADOPTED", target, state: { model: next.model, thinkingLevel: next.thinkingLevel } });
      }
    }
    if (readyLifecycle === "restarting") {
      host.observeLifecycle("restarting");
      host.setNotice("Pi Chat 正在构建并重启，暂时停止接收新操作…");
      source.close();
      host.waitForHandoff();
      return;
    }
    if (readyLifecycle !== "idle") {
      if (readyLifecycle === "resources-reloading" && !host.resourceReloadActive()) {
        host.setResourceReloadActive();
        host.resetResourceReloadTransientState();
      }
      host.observeLifecycle(readyLifecycle);
      if (readyLifecycle === "shutting-down") {
        source.close();
        host.setCloseComplete("application");
        window.setTimeout(() => window.close(), 40);
      } else host.setNotice(readyLifecycle === "workspace-changing" ? "正在切换工作目录…" : "正在更新配置并重载 Runtime…");
      return;
    }
    const completedRuntimeReload = host.resourceReloadActive();
    host.clearResourceReloadActive();
    host.startIdleRecovery(serverEpochChanged, readyNeedsMetadataRefresh || completedRuntimeReload);
  };
}
