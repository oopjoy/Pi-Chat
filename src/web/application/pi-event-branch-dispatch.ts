import { handlePiMessageAndStreamingEvents } from "./pi-event-message-streaming";
import { handlePiRuntimeLifecycleEvents } from "./pi-event-runtime-lifecycle";
import { handlePiWorkspaceAndSessionEvents } from "./pi-event-workspace-session";
import { handlePiQueueAndExtensionEvents } from "./pi-event-queue-extension";
import { handlePiFailureAndControlEvents } from "./pi-event-failure-control";

export function dispatchPiEventBranch(scope: Record<string, any>): boolean {
  return handlePiMessageAndStreamingEvents(scope)
    || handlePiRuntimeLifecycleEvents(scope)
    || handlePiWorkspaceAndSessionEvents(scope)
    || handlePiQueueAndExtensionEvents(scope)
    || handlePiFailureAndControlEvents(scope);
}
