import { spawn } from "node:child_process";

export function observeOwnedProcess(child, processGroup = false) {
  const close = { confirmed: false, promise: Promise.resolve() };
  close.promise = new Promise((resolveClose) => {
    child.once("close", () => {
      close.confirmed = true;
      resolveClose();
    });
  });
  return { child, close, processGroup };
}

export async function waitForOwnedProcessClose(observed, timeoutMs) {
  if (observed.close.confirmed) return true;
  return Promise.race([
    observed.close.promise.then(() => true),
    new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), timeoutMs)),
  ]);
}

export function requireSuccessfulTaskkill(code, pid) {
  if (code !== 0)
    throw new Error(`taskkill failed for owned process tree ${pid} with exit code ${code}`);
}

async function taskkillTree(pid) {
  const result = await new Promise((resolveKill) => {
    const killer = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `taskkill /PID ${pid} /T /F`], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", (error) => resolveKill({ code: null, error }));
    killer.once("exit", (code) => resolveKill({ code }));
  });
  if (result.error) throw result.error;
  requireSuccessfulTaskkill(result.code, pid);
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = error?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return !processGroupExists(pid);
}

export async function waitForOwnedProcessTreeExit(observed, timeoutMs) {
  const pid = observed.child.pid;
  if (observed.processGroup && pid && process.platform !== "win32") {
    const [groupExited, wrapperClosed] = await Promise.all([
      waitForProcessGroupExit(pid, timeoutMs),
      waitForOwnedProcessClose(observed, timeoutMs),
    ]);
    return groupExited && wrapperClosed;
  }
  return waitForOwnedProcessClose(observed, timeoutMs);
}

export async function terminateOwnedProcessTree(observed, timeoutMs = 10_000) {
  const pid = observed.child.pid;
  if (!pid) throw new Error("Owned process tree has no PID");
  if (process.platform === "win32") {
    if (!observed.close.confirmed) await taskkillTree(pid);
  } else if (observed.processGroup) {
    if (processGroupExists(pid)) process.kill(-pid, "SIGTERM");
    if (!await waitForProcessGroupExit(pid, timeoutMs) && processGroupExists(pid))
      process.kill(-pid, "SIGKILL");
  } else if (!observed.close.confirmed) {
    if (!observed.child.kill("SIGTERM")) throw new Error(`Failed to signal owned process ${pid}`);
    if (!await waitForOwnedProcessClose(observed, timeoutMs)) {
      if (!observed.child.kill("SIGKILL")) throw new Error(`Failed to force owned process ${pid}`);
    }
  }
  if (!await waitForOwnedProcessTreeExit(observed, timeoutMs))
    throw new Error(`Owned process tree ${pid} did not confirm exit`);
}
