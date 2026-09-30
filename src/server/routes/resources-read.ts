import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResourceManager, ResourceBrowseKind } from "../resource-manager.js";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";
import { openWithDefaultApplication, revealInExplorer } from "../file-picker.js";

type ResourceHost = Pick<ResourceManager, "listSkills" | "listExtensions" | "listPackages" | "resolveBrowsePath">;

export interface ResourcesReadRouteHost {
  resources: ResourceHost;
  primaryRuntimeCwd(): string;
}

const BROWSE_KINDS = new Set<ResourceBrowseKind>([
  "skills-root",
  "extensions-root",
  "packages-root",
  "models-root",
]);

/** Read-only Resource inventory and local browse route adapter. */
export async function handleResourcesReadRoute(
  host: ResourcesReadRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === "/api/resources/browse") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const body = await bodyJson(request);
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!BROWSE_KINDS.has(kind as ResourceBrowseKind)) {
      json(response, 400, { error: "kind 无效" });
      return true;
    }
    const resourceKind = kind as ResourceBrowseKind;
    const path = host.resources.resolveBrowsePath(resourceKind);
    if (resourceKind === "models-root") await openWithDefaultApplication(path);
    else await revealInExplorer(path);
    json(response, 200, { ok: true, path });
    return true;
  }

  if (url.pathname === "/api/resources/skills") {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return true;
    }
    const result = await host.resources.listSkills(host.primaryRuntimeCwd());
    json(response, 200, { ...result, resources: result.resources.filter((item) => item.enabled) });
    return true;
  }

  if (url.pathname === "/api/resources/extensions") {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return true;
    }
    const result = await host.resources.listExtensions(host.primaryRuntimeCwd());
    json(response, 200, { ...result, resources: result.resources.filter((item) => item.enabled) });
    return true;
  }

  if (url.pathname === "/api/resources/packages") {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return true;
    }
    const result = await host.resources.listPackages(host.primaryRuntimeCwd());
    json(response, 200, { ...result, resources: result.resources.filter((item) => item.enabled) });
    return true;
  }

  return false;
}
