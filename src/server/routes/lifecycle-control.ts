import type { IncomingMessage, ServerResponse } from "node:http";
import { bodyJson, json, methodNotAllowed, requestClientId, requestPageId } from "../http-transport.js";
import type { RuntimeSetupChange } from "../../shared/runtime-setup.js";
import { parseRuntimeSetupChange } from "../runtime-setup.js";

export interface LifecycleControlRouteHost {
  applicationShutdownAvailable(): boolean;
  applicationRestartAvailable(): boolean;
  isConnectedWindowPage(clientId: string, pageId: string): boolean;
  beginLifecycle(lifecycle: "shutting-down" | "restarting"): void;
  endLifecycle(lifecycle: "shutting-down" | "restarting"): void;
  verifyApplicationQuiescent(reason: string): Promise<void>;
  broadcast(event: Record<string, unknown>): void;
  shutdown?(reason: string): void;
  restart(): Promise<{
    promote(): Promise<void>;
    discard(): Promise<void>;
    handoff(): void;
  }>;
  runtimeRestart?(change: RuntimeSetupChange): ReturnType<LifecycleControlRouteHost["restart"]>;
  reportIncident(error: unknown, input: unknown): { incidentId: string };
}

export async function handleLifecycleControlRoute(
  host: LifecycleControlRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const runtimeRestart = url.pathname === "/api/runtime/restart";
  if (!runtimeRestart && url.pathname !== "/api/restart" && url.pathname !== "/api/shutdown") return false;
  if (request.method !== "POST") {
    methodNotAllowed(response);
    return true;
  }
  const shuttingDown = url.pathname === "/api/shutdown";
  if (shuttingDown && !host.applicationShutdownAvailable()) {
    json(response, 501, { error: "当前启动方式不支持从网页关闭 Pi Chat；请关闭服务进程。" });
    return true;
  }
  if (runtimeRestart && !host.runtimeRestart) {
    json(response, 501, { error: "当前启动方式不支持免构建重启，请关闭 Pi Chat 后重新启动。" });
    return true;
  }
  if (!shuttingDown && !runtimeRestart && !host.applicationRestartAvailable()) {
    json(response, 501, { error: "当前启动方式不支持应用更新并重启；请在 Pi Chat 项目目录运行 npm run build 后重启服务。" });
    return true;
  }
  const clientId = requestClientId(request);
  const pageId = requestPageId(request);
  if (!clientId || !pageId) {
    json(response, 400, {
      error: "重启或关闭必须由当前 Pi Chat 页面显式发起",
      code: "LIFECYCLE_CLIENT_REQUIRED",
    });
    return true;
  }
  if (!host.isConnectedWindowPage(clientId, pageId)) {
    const incident = host.reportIncident(new Error("生命周期请求页面没有活动事件连接"), {
      browserId: clientId,
      pageId,
      operation: shuttingDown ? "lifecycle.shutdown" : "lifecycle.restart",
      controlState: "no-browser-identity",
      outcome: "rejected",
      errorCode: "LIFECYCLE_PAGE_NOT_CONNECTED",
    });
    json(response, 409, {
      error: "当前页面尚未完成连接或已断开，无法安全重启或关闭 Pi Chat",
      code: "LIFECYCLE_PAGE_NOT_CONNECTED",
      incidentId: incident.incidentId,
    });
    return true;
  }
  // A slow or malformed body cannot hold the exclusive lifecycle barrier.
  const runtimeChange = runtimeRestart ? parseRuntimeSetupChange(await bodyJson(request, 8192)) : null;
  if (runtimeChange && !host.isConnectedWindowPage(clientId, pageId)) {
    json(response, 409, { error: "当前页面已断开，请重新连接后再应用 Pi 入口。", code: "LIFECYCLE_PAGE_NOT_CONNECTED" });
    return true;
  }
  const lifecycle = shuttingDown ? "shutting-down" : "restarting";
  host.beginLifecycle(lifecycle);
  try {
    await host.verifyApplicationQuiescent(shuttingDown ? "关闭 Pi Chat" : runtimeRestart ? "应用 Pi 入口并重启服务" : "应用更新并重启");
    if (shuttingDown) {
      host.broadcast({ type: "pi_chat_application_closing" });
      json(response, 202, { shuttingDown: true });
      host.shutdown?.("api-shutdown");
      return true;
    }
    const prepared = runtimeChange ? await host.runtimeRestart!(runtimeChange) : await host.restart();
    try {
      await host.verifyApplicationQuiescent("完成重启");
      await prepared.promote();
    } catch (error) {
      await prepared.discard();
      throw error;
    }
    json(response, 202, { restarting: true });
    prepared.handoff();
    return true;
  } catch (error) {
    host.endLifecycle(lifecycle);
    throw error;
  }
}
