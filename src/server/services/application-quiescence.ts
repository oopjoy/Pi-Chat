import { asState } from "../pi-data.js";
import { ApplicationBusyError } from "../application-lifecycle.js";

export interface ApplicationQuiescencePorts {
  busyConversationCount(): number;
  transitioningCount(): number;
  activeMutationRequests(): number;
  primaryReadReady(): boolean;
  primaryState(): Promise<Record<string, unknown>>;
  secondaryStates(): Promise<Array<Record<string, unknown> | null>>;
}

export function assertApplicationQuiescent(
  ports: ApplicationQuiescencePorts,
  action: string,
): void {
  const busyCount = ports.busyConversationCount();
  const transitioningCount = ports.transitioningCount();
  if (busyCount || transitioningCount || ports.activeMutationRequests()) {
    throw new ApplicationBusyError(
      `仍有 ${busyCount + transitioningCount} 个对话正在执行、启动、停止、排队或等待确认，请处理完成后再${action}`,
    );
  }
}

export async function verifyApplicationQuiescent(
  ports: ApplicationQuiescencePorts,
  action: string,
): Promise<void> {
  assertApplicationQuiescent(ports, action);
  const primaryState = ports.primaryReadReady() ? await ports.primaryState() : null;
  const secondaryStates = await ports.secondaryStates();
  if ([primaryState, ...secondaryStates].some((response) => response && asState(response).isStreaming))
    throw new ApplicationBusyError(`仍有对话正在执行，请完成后再${action}`);
  assertApplicationQuiescent(ports, action);
}
