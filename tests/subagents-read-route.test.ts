import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { BackgroundSubagentSnapshot } from "../src/shared/types";
import { handleSubagentsReadRoute } from "../src/server/routes/subagents-read";

const ID = "0123456789abcdefabcd";
const SNAPSHOT: BackgroundSubagentSnapshot = {
  total: 1,
  activeCount: 1,
  attentionCount: 0,
  truncated: false,
  steps: [{ key: "subagent-1", label: "实施子代理 1", status: "running", elapsedMs: 1, updateAgeMs: 2 }],
};

async function fixture(found = true) {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void handleSubagentsReadRoute({
      backgroundSubagents: async (sessionId) => {
        calls.push(sessionId);
        return found ? SNAPSHOT : null;
      },
    }, request, response, url).then((handled) => {
      if (!handled) {
        response.statusCode = 404;
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("background Subagent route is GET-only and returns the safe projection", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/sessions/${ID}/background-subagents`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), SNAPSHOT);
    assert.deepEqual(target.calls, [ID]);
    assert.equal((await fetch(`${target.origin}/api/sessions/${ID}/background-subagents`, { method: "POST" })).status, 405);
  } finally {
    await target.close();
  }
});

test("background Subagent route fails closed for an unknown Session", async () => {
  const target = await fixture(false);
  try {
    const response = await fetch(`${target.origin}/api/sessions/${ID}/background-subagents`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "会话不存在" });
  } finally {
    await target.close();
  }
});
