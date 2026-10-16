import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { promisify } from "node:util";
import { assertReleaseIdentity } from "./release-package.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(import.meta.dirname, "..");

/** Repository files bundled next to the staged dist so the archive runs standalone. */
const PORTABLE_EXTRA_FILES = [
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "pi-chat-launch.cmd",
  "start-pi-chat.cmd",
  "start-pi-chat-ui.ps1",
  "scripts/install-shortcuts.ps1",
  "scripts/pi-chat-launch-process.ps1",
  "scripts/pi-chat-port-ready.ps1",
  "scripts/pi-chat-preflight.ps1",
  "scripts/pi-chat-resolve-runtime.ps1",
  "scripts/pi-chat-start-server.ps1",
  "scripts/detect-pi-entry.mjs",
  "scripts/check-runtime-files.mjs",
  "scripts/runtime-required-files.json",
];

export function assertPortableArtifactName(name) {
  if (!name || name !== basename(name) || /[\\/:\u0000-\u001f\u007f]/.test(name)
    || /[ .]$/.test(name) || !/^pi-chat-portable-\d+\.\d+\.\d+\.zip$/.test(name)) {
    throw new Error("Portable artifact must be a portable basename named pi-chat-portable-<version>.zip");
  }
  return name;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function sortedFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await sortedFiles(path, name));
    else if (entry.isFile()) files.push({ path, name });
  }
  return files;
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: Math.max(1980, date.getFullYear()) === date.getFullYear()
      ? (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate())
      : ((2107 - 1980) << 9) | (12 << 5) | 31,
  };
}

/**
 * Write a ZIP archive with forward-slash entry names (Linux/macOS friendly)
 * and no Zip64: the app payload is a few MB, far below every limit.
 */
export async function writeZip(entries, outputPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = await readFile(entry.path);
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(data);
    const stored = compressed.length >= data.length;
    const payload = stored ? data : compressed;
    const { date, time } = dosDateTime((await stat(entry.path)).mtime);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names.
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 34); // Disk number start.
    central.writeUInt16LE(0, 36); // Internal attributes.
    central.writeUInt32LE(32 << 16, 38); // External attributes: regular file (0644 << 16).
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const centralStart = offset;
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(centralStart, 16);
  await writeFile(outputPath, Buffer.concat([...locals, centralBuffer, end]));
  return { entries: entries.length, bytes: centralStart + centralBuffer.length + end.length };
}

async function gitCommit(repoRoot, ref) {
  const { stdout } = await execFile("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot, windowsHide: true });
  return stdout.trim();
}

function sameOrInside(base, target) {
  const remainder = relative(base, target);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

/** Assemble the portable archive: staged dist plus launch scripts and docs. */
export async function packagePortable({ repoRoot = projectRoot, stagingDir, outputDir, tag }) {
  if (!stagingDir || !outputDir || !tag) throw new Error("stagingDir, outputDir and tag are required");
  const root = resolve(repoRoot), stage = resolve(stagingDir), output = resolve(outputDir);
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const name = assertPortableArtifactName(`pi-chat-portable-${packageJson.version}.zip`);
  const headRevision = await gitCommit(root, "HEAD"), tagRevision = await gitCommit(root, tag);
  const buildIdentity = JSON.parse(await readFile(resolve(stage, "build-identity.json"), "utf8"));
  assertReleaseIdentity({ buildIdentity, packageVersion: packageJson.version, headRevision, tagRevision, tag });
  const entries = [...await sortedFiles(stage)];
  const stageRoot = resolve(stage);
  for (const extra of PORTABLE_EXTRA_FILES) {
    const source = resolve(root, extra);
    if (!sameOrInside(root, source)) throw new Error(`Portable extra escapes the repository: ${extra}`);
    entries.push({ path: source, name: extra.replaceAll(sep, "/") });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(output, { recursive: true });
  const outputPath = resolve(output, name);
  const result = await writeZip(entries, outputPath);
  return { outputPath, name, ...result };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const option = key => args[args.indexOf(key) + 1];
  if (args.length !== 6 || !["--staging", "--output", "--tag"].every(key => args.includes(key))) {
    console.error("Usage: node scripts/portable-package.mjs --staging <dist> --output <dir> --tag <tag>");
    process.exitCode = 2;
  } else packagePortable({ stagingDir: option("--staging"), outputDir: option("--output"), tag: option("--tag") })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(`[Pi Chat] Portable packaging failed: ${error.message}`); process.exitCode = 1; });
}
