import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export function verificationSteps(mode) {
  if (mode === "unit") return [{ kind: "staged", label: "unit", args: ["test"] }];
  if (mode === "e2e")
    return [{ kind: "staged", label: "e2e", args: ["run", "test:e2e"] }];
  if (mode === "all")
    return [
      { kind: "npm", label: "typecheck", args: ["run", "typecheck"] },
      { kind: "staged", label: "unit", args: ["test"] },
      { kind: "staged", label: "e2e", args: ["run", "test:e2e"] },
      { kind: "plain", label: "diff-check", command: "git", args: ["diff", "HEAD", "--check"] },
    ];
  throw new Error(`Unknown verification mode: ${mode}`);
}

export function npmInvocation(args, environment = process.env) {
  const npmExecPath = environment.npm_execpath?.trim();
  if (process.platform === "win32" && npmExecPath) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command: npmCommand, args };
}

export function runProcess(command, args, { cwd = projectRoot, env = process.env } = {}) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited from signal ${signal}`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

export async function runStagedVerification(
  mode,
  {
    cwd = projectRoot,
    environment = process.env,
    execute = runProcess,
    createStage = (label) => mkdtemp(join(tmpdir(), `pi-chat-${label}-`)),
    removeStage = (path) => rm(path, { recursive: true, force: true }),
    log = console,
  } = {},
) {
  const completed = [];
  for (const step of verificationSteps(mode)) {
    if (step.kind === "plain" || step.kind === "npm") {
      log.error(`[Pi Chat] Verifying ${step.label}...`);
      const invocation = step.kind === "npm"
        ? npmInvocation(step.args, environment)
        : { command: step.command, args: step.args };
      const code = await execute(invocation.command, invocation.args, {
        cwd,
        env: environment,
      });
      completed.push({ label: step.label, code });
      if (code !== 0) return { ok: false, completed, failed: step.label };
      continue;
    }

    const stage = await createStage(step.label);
    log.error(`[Pi Chat] Verifying ${step.label} in ${stage}`);
    let code;
    try {
      const stagedEnvironment = {
        ...environment,
        PI_CHAT_DIST_DIR: stage,
      };
      const invocation = npmInvocation(step.args, stagedEnvironment);
      code = await execute(invocation.command, invocation.args, {
        cwd,
        env: stagedEnvironment,
      });
    } catch (error) {
      log.error(`[Pi Chat] ${step.label} staging retained after launch failure: ${stage}`);
      throw error;
    }
    completed.push({ label: step.label, code, stage });
    if (code !== 0) {
      log.error(`[Pi Chat] ${step.label} staging retained for diagnostics: ${stage}`);
      return { ok: false, completed, failed: step.label, retainedStage: stage };
    }
    try {
      await removeStage(stage);
    } catch (error) {
      log.error(
        `[Pi Chat] ${step.label} passed but staging cleanup failed; retained path: ${stage}`,
      );
      return {
        ok: false,
        completed,
        failed: `${step.label}-cleanup`,
        retainedStage: stage,
        error,
      };
    }
    log.error(`[Pi Chat] Removed successful ${step.label} staging: ${stage}`);
  }
  return { ok: true, completed };
}

function usage() {
  return "Usage: node scripts/run-staged-verification.mjs <unit|e2e|all>";
}

async function main() {
  const mode = process.argv[2];
  if (!mode || process.argv.length !== 3) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = await runStagedVerification(mode);
  } catch (error) {
    if (/^Unknown verification mode:/.test(error.message)) {
      console.error(error.message);
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`[Pi Chat] Staged verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
