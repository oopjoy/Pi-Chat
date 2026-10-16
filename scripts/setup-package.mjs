import { execFile as execFileCallback } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertRuntimeFiles } from "./check-runtime-files.mjs";
import { prepareSetupInputs, windowsBuildEnvironment } from "./prepare-setup-inputs.mjs";
import { validateDistTarget } from "./dist-paths.mjs";

const execute = promisify(execFileCallback);
export const applicationPackageFiles = [
  "package.json", "LICENSE", "README.md", "SECURITY.md", "resources",
  "pi-chat-launch.cmd", "start-pi-chat.cmd", "start-pi-chat-ui.ps1",
  "scripts/pi-chat-launch-process.ps1", "scripts/pi-chat-port-ready.ps1",
  "scripts/pi-chat-preflight.ps1", "scripts/pi-chat-resolve-runtime.ps1", "scripts/pi-chat-start-server.ps1",
  "scripts/pi-chat-setup.ps1", "scripts/detect-pi-entry.mjs",
  "scripts/check-runtime-files.mjs", "scripts/runtime-required-files.json",
];

/** One Inno EXE. The temporary payload is never published as a portable ZIP. */
export async function buildSetup({ repoRoot = resolve(import.meta.dirname, ".."), stagingDir, outputPath, inputs, appId } = {}) {
  if (!stagingDir || !outputPath) throw new Error("Setup requires an isolated staging directory and outputPath");
  const root = resolve(repoRoot);
  if (validateDistTarget({ projectRoot: root, requested: stagingDir }).kind === "live") throw new Error("Setup staging must not be live dist");
  if (validateDistTarget({ projectRoot: root, requested: dirname(outputPath) }).kind === "live") throw new Error("Setup output must not be live dist");
  await assertRuntimeFiles(root, stagingDir);
  const dependencies = inputs || await prepareSetupInputs();
  const payload = await mkdtemp(join(tmpdir(), "pi-chat-setup-payload-"));
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    const app = join(payload, "app");
    await mkdir(app);
    for (const file of applicationPackageFiles) await cp(join(root, file), join(app, file), { recursive: true });
    await cp(stagingDir, join(app, "dist"), { recursive: true });
    await assertRuntimeFiles(app);
    await cp(dependencies.nodeRoot, join(payload, "runtime/node"), { recursive: true });
    const { stdout } = await execute(join(payload, "runtime/node/node.exe"), ["--version"], { env: windowsBuildEnvironment(), windowsHide: true });
    if (stdout.trim() !== `v${dependencies.node.version}`) throw new Error("Embedded Node version mismatch");
    if (!dependencies.piRoot) throw new Error("Setup payload is missing the bundled Pi runtime");
    await cp(dependencies.piRoot, join(payload, "runtime/pi"), { recursive: true });
    const piPackage = JSON.parse(await readFile(join(payload, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
    if (piPackage.version !== dependencies.pi.version) throw new Error("Embedded Pi version mismatch");
    await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts/build-setup-exe.ps1"),
      "-PayloadRoot", payload, "-CompilerPath", dependencies.compiler, "-Output", resolve(outputPath), ...(appId ? ["-AppId", appId] : [])], {
      cwd: root, env: windowsBuildEnvironment(), windowsHide: true, timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
    });
    await access(outputPath);
    return { nodeVersion: dependencies.node.version, nodeArchiveSha256: dependencies.node.sha256, piPackage: dependencies.pi.package, piVersion: dependencies.pi.version, compilerVersion: dependencies.inno.version };
  } catch (error) {
    try { await rm(outputPath, { force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* keep the compile error */ }
    throw error;
  } finally {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await rm(payload, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        break;
      } catch (cleanup) {
        if (attempt === 5) console.error(`[Pi Chat] Setup payload cleanup: ${cleanup.message}`);
        else await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  if (!args.includes("--staging") || !args.includes("--output")) {
    console.error("Usage: npm run build:setup -- --staging <isolated-dist> --output <setup.exe>");
    process.exitCode = 2;
  } else buildSetup({ stagingDir: option("--staging"), outputPath: option("--output") }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message, error.stderr || ""); process.exitCode = 1;
  });
}
