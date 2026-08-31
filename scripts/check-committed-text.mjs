import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(import.meta.dirname, "..");

const lfPathspecs = [
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.js",
  "*.mjs",
  "*.json",
  "*.jsonl",
  "*.md",
  "*.css",
  "*.html",
  "*.webmanifest",
  "*.svg",
  "*.yml",
  "*.yaml",
  "*.toml",
  "*.txt",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
];

async function assertNoCommittedMatch({ repoRoot, paths, pattern, flags, description }) {
  const pathspecs = paths?.length ? paths : lfPathspecs;
  try {
    await execFile("git", ["grep", "-n", "-I", ...flags, pattern, "HEAD", "--", ...pathspecs], {
      cwd: repoRoot,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (error?.code === 1) return;
    const detail = `${error?.stdout || ""}${error?.stderr || ""}`.trim();
    throw new Error(
      `Committed text check failed${detail ? `: ${detail}` : ""}`,
      { cause: error },
    );
  }
  throw new Error(`Committed text contains ${description}: ${pathspecs.join(", ")}`);
}

export async function assertCommittedLf({ repoRoot = projectRoot, paths } = {}) {
  await assertNoCommittedMatch({
    repoRoot,
    paths,
    flags: ["-F"],
    pattern: "\r",
    description: "CR bytes",
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--all") {
    console.error("Usage: node scripts/check-committed-text.mjs --all");
    process.exitCode = 2;
    return;
  }
  await assertCommittedLf();
  console.log("[Pi Chat] committed LF text check passed");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`[Pi Chat] ${error.message}`);
    process.exitCode = 1;
  });
}
