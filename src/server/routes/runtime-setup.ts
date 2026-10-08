import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeEntryInfo, RuntimeSetupStatus } from "../../shared/runtime-setup.js";
import { json, methodNotAllowed, requestClientId, requestPageId } from "../http-transport.js";

export interface RuntimeSetupReadHost {
  status?: () => RuntimeSetupStatus;
  pick?: () => Promise<RuntimeEntryInfo | null>;
  isConnectedWindowPage(clientId: string, pageId: string): boolean;
}

export async function handleRuntimeSetupRoute(host: RuntimeSetupReadHost, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/runtime/setup" && url.pathname !== "/api/runtime/pick") return false;
  const picking = url.pathname === "/api/runtime/pick";
  if (request.method !== (picking ? "POST" : "GET")) {
    methodNotAllowed(response);
    return true;
  }
  if (!host.status || (picking && !host.pick)) {
    json(response, 501, { error: "当前启动方式不支持 Pi 入口配置，请升级或从标准 Pi Chat 服务入口启动。" });
    return true;
  }
  if (picking && !host.isConnectedWindowPage(requestClientId(request), requestPageId(request))) {
    json(response, 409, { error: "请等待当前页面连接完成后再选择 Pi 入口。", code: "LIFECYCLE_PAGE_NOT_CONNECTED" });
    return true;
  }
  json(response, 200, picking ? { candidate: await host.pick!() } : host.status());
  return true;
}
