import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionResource, PackageResource, PluginResourceItem, ResourceResponse, SkillResource } from "../shared/types.js";
import { resolvePiEntry } from "./rpc-client.js";

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

async function writeSettingsAtomic(path: string, settings: PiSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.pi-chat-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temp, path);
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
  private readonly skillPaths = new Map<string, string>();

  constructor(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) {
    this.agentDir = agentDir;
    this.settingsPath = join(agentDir, "settings.json");
  }

  async listSkills(cwd: string): Promise<ResourceResponse<SkillResource>> {
    const settings = await readSettings(this.settingsPath);
    const candidates: Array<{ path: string; source: SkillResource["source"]; packageSource?: string; enabled: boolean; removable: boolean }> = [];
    const userSkills = join(this.agentDir, "skills");
    const agentsSkills = join(homedir(), ".agents", "skills");
    for (const path of await walkFiles(userSkills, (file) => basename(file).toLowerCase() === "skill.md" || (dirname(file) === userSkills && extname(file).toLowerCase() === ".md"))) {
      candidates.push({ path, source: "user", enabled: true, removable: true });
    }
    for (const path of await walkFiles(agentsSkills, (file) => basename(file).toLowerCase() === "skill.md")) {
      candidates.push({ path, source: "agents", enabled: true, removable: true });
    }
    for (const configured of settings.skills ?? []) {
      if (/^[+\-!]/.test(configured)) continue;
      const root = resolve(this.agentDir, configured);
      const info = existsSync(root) ? await stat(root) : null;
      const files = info?.isDirectory() ? await walkFiles(root, (file) => basename(file).toLowerCase() === "skill.md" || extname(file).toLowerCase() === ".md") : info?.isFile() ? [root] : [];
      for (const path of files) candidates.push({ path, source: "custom", enabled: true, removable: false });
    }
    for (const entry of settings.packages ?? []) {
      const source = packageSource(entry);
      const packageRoot = resolvePackagePath(source, this.agentDir, cwd);
      if (!packageRoot || !existsSync(packageRoot)) continue;
      for (const resource of await manifestResources(packageRoot)) {
        if (resource.key !== "skills") continue;
        const files = await walkFiles(resource.path, (file) => basename(file).toLowerCase() === "skill.md" || (dirname(file) === resource.path && extname(file).toLowerCase() === ".md"));
        for (const path of files) candidates.push({ path, source: "package", packageSource: source, enabled: !packageDisabled(entry), removable: false });
      }
    }

    const unique = new Map<string, SkillResource>();
    this.skillPaths.clear();
    for (const candidate of candidates) {
      const normalized = resolve(candidate.path);
      if (unique.has(normalized.toLowerCase())) continue;
      const content = await readFile(normalized, "utf8");
      const frontmatter = parseFrontmatter(content);
      const id = hashId(normalized);
      this.skillPaths.set(id, normalized);
      unique.set(normalized.toLowerCase(), {
        id,
        name: frontmatter.name || (basename(normalized).toLowerCase() === "skill.md" ? basename(dirname(normalized)) : basename(normalized, extname(normalized))),
        description: frontmatter.description || "No description",
        pathLabel: pathLabel(normalized),
        source: candidate.source,
        packageSource: candidate.packageSource,
        enabled: candidate.enabled && !frontmatter.disabled,
        removable: candidate.removable,
        content: content.slice(0, 200_000),
      });
    }
    return { resources: [...unique.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics: [] };
  }

  async setSkillEnabled(id: string, enabled: boolean, cwd: string): Promise<void> {
    const skill = (await this.listSkills(cwd)).resources.find((item) => item.id === id);
    if (!skill) throw new Error("Skill not found");
    const realPath = await this.skillPathFromId(id, cwd);
    if (!realPath) throw new Error("Skill path not found");
    const content = await readFile(realPath, "utf8");
    const keyPattern = /^disable-model-invocation\s*:.*\r?\n/m;
    let updated = content;
    if (enabled) updated = content.replace(keyPattern, "");
    else if (keyPattern.test(content)) updated = content.replace(keyPattern, "disable-model-invocation: true\n");
    else if (/^---\r?\n/.test(content)) updated = content.replace(/^---\r?\n/, "---\ndisable-model-invocation: true\n");
    else updated = `---\ndisable-model-invocation: true\n---\n${content}`;
    await writeFile(realPath, updated, "utf8");
  }

  private async skillPathFromId(id: string, cwd: string): Promise<string | null> {
    await this.listSkills(cwd);
    return this.skillPaths.get(id) ?? null;
  }

  async installSkill(sourcePath: string): Promise<void> {
    const source = resolve(sourcePath);
    if (!existsSync(source)) throw new Error("Skill source path does not exist");
    const info = await stat(source);
    const targetRoot = join(this.agentDir, "skills");
    await mkdir(targetRoot, { recursive: true });
    if (info.isDirectory()) {
      if (!existsSync(join(source, "SKILL.md"))) throw new Error("Skill directory must contain SKILL.md");
      const target = join(targetRoot, basename(source));
      if (existsSync(target)) throw new Error(`Skill already exists: ${basename(source)}`);
      await cp(source, target, { recursive: true, errorOnExist: true });
    } else if (info.isFile() && extname(source).toLowerCase() === ".md") {
      const target = join(targetRoot, basename(source));
      if (existsSync(target)) throw new Error(`Skill already exists: ${basename(source)}`);
      await cp(source, target, { errorOnExist: true });
    } else throw new Error("Skill source must be a directory or Markdown file");
  }

  async removeSkill(id: string, cwd: string): Promise<void> {
    const resource = (await this.listSkills(cwd)).resources.find((item) => item.id === id);
    if (!resource?.removable) throw new Error("This skill cannot be removed here");
    const path = await this.skillPathFromId(id, cwd);
    if (!path) throw new Error("Skill path not found");
    const userRoot = resolve(this.agentDir, "skills").toLowerCase();
    const agentsRoot = resolve(homedir(), ".agents", "skills").toLowerCase();
    const normalized = resolve(path).toLowerCase();
    if (!normalized.startsWith(`${userRoot}\\`) && !normalized.startsWith(`${agentsRoot}\\`) && process.platform === "win32") throw new Error("Refusing to remove a skill outside managed directories");
    if (!normalized.startsWith(`${userRoot}/`) && !normalized.startsWith(`${agentsRoot}/`) && process.platform !== "win32") throw new Error("Refusing to remove a skill outside managed directories");
    await rm(basename(path).toLowerCase() === "skill.md" ? dirname(path) : path, { recursive: true, force: true });
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
        enabled: !packageDisabled(entry), removable: true, installedPath: installed ? pathLabel(installed) : undefined,
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
      resources.push({
        id: hashId(`extension\0${resolve(path)}`), name: /^index\./i.test(basename(path)) ? basename(dirname(path)) : basename(path, extname(path)),
        source: pathLabel(path), scope: "global", enabled: !override?.startsWith("-") && !override?.startsWith("!"),
        removable: true, installedPath: pathLabel(path),
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
          removable: false, packageSource: source,
        });
      }
    }
    return { resources: resources.sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  }

  async setPackageEnabled(id: string, enabled: boolean, cwd: string): Promise<void> {
    if (!(await this.listPackages(cwd)).resources.some((item) => item.id === id)) throw new Error("Package not found");
    const settings = await readSettings(this.settingsPath);
    let found = false;
    settings.packages = (settings.packages ?? []).map((entry): PackageSetting => {
      if (hashId(`global\0${packageSource(entry)}`) !== id) return entry;
      found = true;
      return enabled ? packageSource(entry) : { ...(typeof entry === "string" ? { source: entry } : entry), extensions: [], skills: [], prompts: [], themes: [] };
    });
    if (!found) throw new Error("Package setting not found");
    await writeSettingsAtomic(this.settingsPath, settings);
  }

  private async extensionPathFromId(id: string): Promise<string | null> {
    const root = join(this.agentDir, "extensions");
    const files = await walkFiles(root, (path) => EXTENSION_PATTERN.test(path) && (dirname(path) === root || /^index\.(?:ts|js)$/i.test(basename(path))), 3);
    return files.find((path) => hashId(`extension\0${resolve(path)}`) === id) ?? null;
  }

  async setExtensionEnabled(id: string, enabled: boolean, cwd: string): Promise<void> {
    const extension = (await this.listExtensions(cwd)).resources.find((item) => item.id === id);
    if (!extension) throw new Error("Extension not found");
    if (extension.packageSource) throw new Error("Package-provided extensions are controlled by their Package switch");
    const realPath = await this.extensionPathFromId(id);
    if (!realPath) throw new Error("Extension path not found");
    const pattern = relative(this.agentDir, realPath);
    const settings = await readSettings(this.settingsPath);
    settings.extensions = (settings.extensions ?? []).filter((entry) => entry.replace(/^[+\-!]/, "") !== pattern && resolve(this.agentDir, entry.replace(/^[+\-!]/, "")) !== resolve(realPath));
    settings.extensions.push(`${enabled ? "+" : "-"}${pattern}`);
    await writeSettingsAtomic(this.settingsPath, settings);
  }

  async installPackage(source: string): Promise<void> { await runPiPackageCommand(["install", source], this.agentDir); }

  async removePackage(id: string, cwd: string): Promise<void> {
    const resource = (await this.listPackages(cwd)).resources.find((item) => item.id === id);
    if (!resource?.removable) throw new Error("Package cannot be removed");
    await runPiPackageCommand(["remove", resource.source], this.agentDir);
  }

  async removeExtension(id: string, cwd: string): Promise<void> {
    const extension = (await this.listExtensions(cwd)).resources.find((item) => item.id === id);
    if (!extension?.removable || extension.packageSource) throw new Error("Package-provided extensions must be removed with their Package");
    const path = await this.extensionPathFromId(id);
    if (!path) throw new Error("Extension path not found");
    const root = resolve(this.agentDir, "extensions").toLowerCase();
    const normalized = resolve(path).toLowerCase();
    const separator = process.platform === "win32" ? "\\" : "/";
    if (!normalized.startsWith(`${root}${separator}`)) throw new Error("Refusing to remove extension outside managed directory");
    await rm(/^index\./i.test(basename(path)) ? dirname(path) : path, { recursive: true, force: true });
    const settings = await readSettings(this.settingsPath);
    settings.extensions = (settings.extensions ?? []).filter((entry) => resolve(this.agentDir, entry.replace(/^[+\-!]/, "")) !== resolve(path) && resolve(this.agentDir, entry.replace(/^[+\-!]/, "")) !== resolve(dirname(path)));
    await writeSettingsAtomic(this.settingsPath, settings);
  }
}

async function runPiPackageCommand(args: string[], agentDir: string): Promise<void> {
  const rpcEntry = resolvePiEntry();
  if (!rpcEntry) throw new Error("Global Pi was not found");
  const cliEntry = join(dirname(rpcEntry), "cli.js");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: agentDir,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(output.trim() || `Pi command exited with code ${code}`)));
  });
}
