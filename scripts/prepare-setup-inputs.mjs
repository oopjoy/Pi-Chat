import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFileCallback);
export const dependencyFile = resolve(import.meta.dirname, "installer-dependencies.json");
export const defaultSetupCache = join(tmpdir(), "pi-chat-setup-dependencies");

export function windowsBuildEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
}

export async function verifiedDownload(spec, directory, fetchImpl = fetch) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, spec.archive);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  if (await readFile(path).then(bytes => hash(bytes) === spec.sha256).catch(() => false)) return path;
  console.error(`[Pi Chat Setup build] Download ${spec.url}`);
  const response = await fetchImpl(spec.url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Build dependency download failed: ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) throw new Error("Build dependency exceeds 100 MiB");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== spec.sha256) throw new Error(`Build dependency checksum mismatch: ${spec.archive}`);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  return path;
}

/** Build-time only. No Node/compiler download occurs in the user installer. */
export async function prepareSetupInputs({ cacheRoot = defaultSetupCache } = {}) {
  if (process.platform !== "win32") throw new Error("Windows Setup compilation requires Windows");
  const specs = JSON.parse(await readFile(dependencyFile, "utf8"));
  const nodeArchive = await verifiedDownload(specs.node, cacheRoot);
  const compilerArchive = await verifiedDownload(specs.inno, cacheRoot);
  const nodeParent = join(cacheRoot, `node-${specs.node.version}`);
  const nodeRoot = join(nodeParent, `node-v${specs.node.version}-win-x64`);
  const compilerRoot = join(cacheRoot, `inno-${specs.inno.version}`);
  const compiler = join(compilerRoot, "ISCC.exe");
  const env = windowsBuildEnvironment();
  if (!await access(join(nodeRoot, "node_modules/npm/bin/npm-cli.js")).then(() => true).catch(() => false)) {
    await rm(nodeParent, { recursive: true, force: true });
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:PI_CHAT_BUILD_NODE_ARCHIVE -DestinationPath $env:PI_CHAT_BUILD_NODE_PARENT -Force"], {
      env: { ...env, PI_CHAT_BUILD_NODE_ARCHIVE: nodeArchive, PI_CHAT_BUILD_NODE_PARENT: nodeParent },
      windowsHide: true, timeout: 240_000,
    });
  }
  if (!await access(compiler).then(() => true).catch(() => false)) {
    // /PORTABLE=1 is supported by Inno's own installer: no uninstall registry,
    // associations or shortcuts. Only the verified build cache is populated.
    await execute(compilerArchive, ["/PORTABLE=1", "/CURRENTUSER", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOICONS", `/DIR=${compilerRoot}`], { env, windowsHide: true, timeout: 120_000 });
  }
  await access(compiler);
  const { stdout } = await execute(join(nodeRoot, "node.exe"), ["--version"], { env, windowsHide: true });
  if (stdout.trim() !== `v${specs.node.version}`) throw new Error("Bundled Node version does not match the verified archive");
  return { nodeRoot, compiler, node: specs.node, inno: specs.inno };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  prepareSetupInputs().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
