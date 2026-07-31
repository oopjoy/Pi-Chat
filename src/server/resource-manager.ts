import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { ExtensionResource, PackageResource, PluginResourceItem, ResourceResponse, SkillResource } from "../shared/types.js";

export type ResourceBrowseKind = "skills-root" | "extensions-root" | "packages-root" | "models-root";

interface PackageFilter {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  autoload?: boolean;
}
type PackageSetting = string | PackageFilter;
interface PiSettings {
  packages?: PackageSetting[];
  extensions?: string[];
  skills?: string[];
  [key: string]: unknown;
}

const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;
const EXTENSION_PATTERN = /\.(?:ts|js|mts|mjs|cts|cjs)$/i;
const PI_CHAT_SYSTEM_EXTENSION_NAMES = new Set(["pi-chat-file-permission-gate"]);

function hashId(value: string): string {
  return createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 20);
}

function pathLabel(path: string): string {
  const home = homedir();
  return path.toLowerCase().startsWith(home.toLowerCase()) ? `~${path.slice(home.length)}` : path;
}

function packageSource(entry: PackageSetting): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packageDisabled(entry: PackageSetting): boolean {
  return typeof entry !== "string" && RESOURCE_KEYS.every((key) => Array.isArray(entry[key]) && entry[key]?.length === 0);
}

function parseFrontmatter(content: string): { name: string; description: string; disabled: boolean } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const frontmatter = match?.[1] || "";
  const value = (key: string) => {
    const keyMatch = new RegExp(`^${key}\\s*:\\s*(.+)$`, "mi").exec(frontmatter);
    return keyMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "";
  };
  return {
    name: value("name"),
    description: value("description").replace(/[>|]-?\s*$/, ""),
    disabled: /^(true|yes|1)$/i.test(value("disable-model-invocation")),
  };
}

async function readSettings(path: string): Promise<PiSettings> {
  try { return JSON.parse(await readFile(path, "utf8")) as PiSettings; } catch { return {}; }
}

async function walkFiles(root: string, predicate: (path: string) => boolean, depth = 8): Promise<string[]> {
  if (!existsSync(root) || depth < 0) return [];
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(path, predicate, depth - 1));
    else if (entry.isFile() && predicate(path)) result.push(path);
  }
  return result;
}

function packageSourceLabel(source: string): string {
  return npmPackageName(source) || source.replace(/^packages[\\/]/, "") || source;
}

function npmPackageName(source: string): string | null {
  if (!source.startsWith("npm:")) return null;
  const spec = source.slice(4);
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const version = spec.indexOf("@", slash);
    return version > 0 ? spec.slice(0, version) : spec;
  }
  const version = spec.lastIndexOf("@");
  return version > 0 ? spec.slice(0, version) : spec;
}

function resolvePackagePath(source: string, agentDir: string, cwd: string): string | null {
  const npmName = npmPackageName(source);
  if (npmName) return join(agentDir, "npm", "node_modules", ...npmName.split("/"));
  if (source.startsWith("git:")) return null;
  if (/^[a-z]+:\/\//i.test(source)) return null;
  return resolve(source.startsWith(".") ? cwd : agentDir, source);
}

async function manifestResources(packageRoot: string): Promise<Array<{ key: typeof RESOURCE_KEYS[number]; path: string }>> {
  let manifest: Record<string, unknown> = {};
  try { manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>; } catch {}
  const pi = manifest.pi && typeof manifest.pi === "object" ? manifest.pi as Record<string, unknown> : {};
  const result: Array<{ key: typeof RESOURCE_KEYS[number]; path: string }> = [];
  for (const key of RESOURCE_KEYS) {
    const configured = Array.isArray(pi[key]) ? pi[key] as unknown[] : null;
    const paths = configured?.filter((value): value is string => typeof value === "string" && !/[*!]/.test(value))
      ?? (existsSync(join(packageRoot, key)) ? [`./${key}`] : []);
    for (const entry of paths) result.push({ key, path: resolve(packageRoot, entry) });
  }
  return result;
}

async function packageMetadata(root: string): Promise<{ name?: string; version?: string; description?: string }> {
  try {
    const value = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    return {
      name: typeof value.name === "string" ? value.name : undefined,
      version: typeof value.version === "string" ? value.version : undefined,
      description: typeof value.description === "string" ? value.description : undefined,
    };
  } catch { return {}; }
}

async function resourceItems(root: string, key: typeof RESOURCE_KEYS[number]): Promise<PluginResourceItem[]> {
  const info = existsSync(root) ? await stat(root) : null;
  const predicate = key === "extensions"
    ? (path: string) => EXTENSION_PATTERN.test(path)
    : key === "skills"
      ? (path: string) => basename(path).toLowerCase() === "skill.md" || (dirname(path) === root && extname(path).toLowerCase() === ".md")
      : (path: string) => key === "prompts" ? extname(path).toLowerCase() === ".md" : extname(path).toLowerCase() === ".json";
  const files = info?.isFile() && predicate(root) ? [root] : info?.isDirectory() ? await walkFiles(root, predicate, key === "skills" ? 6 : 4) : [];
  const kind = key === "extensions" ? "extension" : key === "skills" ? "skill" : key === "prompts" ? "prompt" : "theme";
  return files.map((path) => ({
    kind,
    name: basename(path).replace(/\.(?:ts|js|md|json)$/i, "") === "SKILL" ? basename(dirname(path)) : basename(path).replace(/\.[^.]+$/, ""),
    relativePath: relative(root, path) || basename(path),
  }));
}

export class ResourceManager {
  readonly agentDir: string;
  readonly settingsPath: string;

  constructor(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) {
    this.agentDir = agentDir;
    this.settingsPath = join(agentDir, "settings.json");
  }

  async listSkills(cwd: string): Promise<ResourceResponse<SkillResource>> {
    const settings = await readSettings(this.settingsPath);
    const candidates: Array<{ path: string; source: SkillResource["source"]; packageSource?: string; enabled: boolean }> = [];
    const userSkills = join(this.agentDir, "skills");
    const agentsSkills = join(homedir(), ".agents", "skills");
    for (const path of await walkFiles(userSkills, (file) => basename(file).toLowerCase() === "skill.md" || (dirname(file) === userSkills && extname(file).toLowerCase() === ".md"))) {
      candidates.push({ path, source: "user", enabled: true });
    }
    for (const path of await walkFiles(agentsSkills, (file) => basename(file).toLowerCase() === "skill.md")) {
      candidates.push({ path, source: "agents", enabled: true });
    }
    for (const configured of settings.skills ?? []) {
      if (/^[+\-!]/.test(configured)) continue;
      const root = resolve(this.agentDir, configured);
      const info = existsSync(root) ? await stat(root) : null;
      const files = info?.isDirectory() ? await walkFiles(root, (file) => basename(file).toLowerCase() === "skill.md" || extname(file).toLowerCase() === ".md") : info?.isFile() ? [root] : [];
      for (const path of files) candidates.push({ path, source: "custom", enabled: true });
    }
    for (const entry of settings.packages ?? []) {
      const source = packageSource(entry);
      const packageRoot = resolvePackagePath(source, this.agentDir, cwd);
      if (!packageRoot || !existsSync(packageRoot)) continue;
      for (const resource of await manifestResources(packageRoot)) {
        if (resource.key !== "skills") continue;
        const files = await walkFiles(resource.path, (file) => basename(file).toLowerCase() === "skill.md" || (dirname(file) === resource.path && extname(file).toLowerCase() === ".md"));
        for (const path of files) candidates.push({ path, source: "package", packageSource: source, enabled: !packageDisabled(entry) });
      }
    }

    const unique = new Map<string, SkillResource>();
    for (const candidate of candidates) {
      const normalized = resolve(candidate.path);
      if (unique.has(normalized.toLowerCase())) continue;
      const content = await readFile(normalized, "utf8");
      const frontmatter = parseFrontmatter(content);
      const id = hashId(normalized);
      unique.set(normalized.toLowerCase(), {
        id,
        name: frontmatter.name || (basename(normalized).toLowerCase() === "skill.md" ? basename(dirname(normalized)) : basename(normalized, extname(normalized))),
        description: frontmatter.description || "No description",
        pathLabel: pathLabel(normalized),
        source: candidate.source,
        packageSource: candidate.packageSource,
        enabled: candidate.enabled && !frontmatter.disabled,
        content: content.slice(0, 200_000),
      });
    }
    return { resources: [...unique.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics: [] };
  }

  async listPackages(cwd: string): Promise<ResourceResponse<PackageResource>> {
    const settings = await readSettings(this.settingsPath);
    const resources: PackageResource[] = [];
    const diagnostics: string[] = [];
    for (const entry of settings.packages ?? []) {
      const source = packageSource(entry);
      const packageRoot = resolvePackagePath(source, this.agentDir, cwd);
      const installed = packageRoot && existsSync(packageRoot) ? packageRoot : undefined;
      if (!installed) diagnostics.push(`${source}: configured package path was not found`);
      const metadata = installed ? await packageMetadata(installed) : {};
      const packageResources: PluginResourceItem[] = [];
      if (installed) for (const resource of await manifestResources(installed)) packageResources.push(...await resourceItems(resource.path, resource.key));
      resources.push({
        id: hashId(`global\0${source}`), name: metadata.name || source.replace(/^npm:/, ""), source, scope: "global",
        enabled: !packageDisabled(entry), installedPath: installed ? pathLabel(installed) : undefined,
        version: metadata.version, description: metadata.description, resources: packageResources,
      });
    }
    return { resources: resources.sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  }

  async listExtensions(cwd: string): Promise<ResourceResponse<ExtensionResource>> {
    const settings = await readSettings(this.settingsPath);
    const resources: ExtensionResource[] = [];
    const diagnostics: string[] = [];
    const extensionsRoot = join(this.agentDir, "extensions");
    const extensionFiles = await walkFiles(extensionsRoot, (path) => EXTENSION_PATTERN.test(path) && (dirname(path) === extensionsRoot || /^index\.(?:ts|js)$/i.test(basename(path))), 3);
    for (const path of extensionFiles) {
      const pattern = relative(this.agentDir, path);
      const override = (settings.extensions ?? []).find((entry) => entry.replace(/^[+\-!]/, "") === pattern || resolve(this.agentDir, entry.replace(/^[+\-!]/, "")) === resolve(path));
      const name = /^index\./i.test(basename(path)) ? basename(dirname(path)) : basename(path, extname(path));
      const systemComponent = PI_CHAT_SYSTEM_EXTENSION_NAMES.has(name.toLowerCase());
      // Pi Chat-owned adapters are intentionally not exposed as ordinary plugins.
      // They are verified and repaired by the Pi Chat startup path instead.
      if (systemComponent) continue;
      resources.push({
        id: hashId(`extension\0${resolve(path)}`), name,
        source: pathLabel(path), scope: "global", enabled: !override?.startsWith("-") && !override?.startsWith("!"),
        installedPath: pathLabel(path),
      });
    }
    for (const entry of settings.packages ?? []) {
      const source = packageSource(entry);
      const root = resolvePackagePath(source, this.agentDir, cwd);
      if (!root || !existsSync(root)) { diagnostics.push(`${source}: configured package path was not found`); continue; }
      const packageExtensions: PluginResourceItem[] = [];
      for (const resource of await manifestResources(root)) {
        if (resource.key === "extensions") packageExtensions.push(...await resourceItems(resource.path, resource.key));
      }
      for (const item of packageExtensions) {
        const label = packageExtensions.length > 1 ? `${packageSourceLabel(source)} · ${item.name}` : packageSourceLabel(source);
        resources.push({
          id: hashId(`package-extension\0${source}\0${item.relativePath}`), name: label,
          source: `${source} · ${item.relativePath}`, scope: "global", enabled: !packageDisabled(entry),
          packageSource: source,
        });
      }
    }
    return { resources: resources.sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  }

  /** Managed local root folder used by the read-only resource inventory. */
  resolveBrowsePath(kind: ResourceBrowseKind): string {
    if (kind === "models-root") return this.agentDir;
    if (kind === "skills-root") return join(this.agentDir, "skills");
    if (kind === "extensions-root") return join(this.agentDir, "extensions");
    return join(this.agentDir, "npm", "node_modules");
  }

  async systemGateEnabled(): Promise<boolean> {
    const path = join(this.agentDir, "extensions", "pi-chat-file-permission-gate.ts");
    if (!existsSync(path)) return false;
    const settings = await readSettings(this.settingsPath);
    const pattern = relative(this.agentDir, path).replace(/\\/g, "/");
    const override = (settings.extensions ?? []).find((entry) => entry.replace(/^[+\-!]/, "").replace(/\\/g, "/") === pattern);
    return !override?.startsWith("-") && !override?.startsWith("!");
  }

}
