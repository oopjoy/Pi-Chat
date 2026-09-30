import assert from "node:assert/strict";
import test from "node:test";
import { handleWorkspaceControlRoute } from "../../src/server/routes/workspace-control";

function response() {
  const value: { status?: number; body?: string } = {};
  return {
    value,
    writeHead: (status: number) => { value.status = status; },
    end: (body?: string) => { value.body = body; },
    setHeader: () => {},
  } as never;
}

test("workspace pick commits then bootstraps one authoritative result", async () => {
  const calls: string[] = [];
  const res = response();
  const handled = await handleWorkspaceControlRoute({
    currentCwd: () => "C:\\old",
    pickWorkspaceFolder: async () => { calls.push("pick"); return "C:\\new"; },
    changeWorkspace: async (path) => { calls.push(`change:${path}`); return {}; },
    bootstrap: async () => {
      calls.push("bootstrap");
      return { workspaceCwd: "C:\\new", workspaceEpoch: "epoch", workspaceRevision: 2 } as never;
    },
  }, { method: "POST" } as never, res, new URL("http://localhost/api/workspace/pick"));
  assert.equal(handled, true);
  assert.deepEqual(calls, ["pick", "change:C:\\new", "bootstrap"]);
  assert.equal(res.value.status, 200);
});

test("workspace set uses prepared body and preserves cancellation envelope", async () => {
  const res = response();
  const handled = await handleWorkspaceControlRoute({
    currentCwd: () => "C:\\old",
    pickWorkspaceFolder: async () => null,
    changeWorkspace: async (path) => ({ cwd: path }),
    bootstrap: async () => ({}) as never,
  }, { method: "POST" } as never, res, new URL("http://localhost/api/workspace/set"), { path: "C:\\new" });
  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.value.body || "{}"), { cancelled: false, cwd: "C:\\new" });
});
