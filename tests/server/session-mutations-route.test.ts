import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { handleSessionMutationsRoute } from "../../src/server/routes/session-mutations";

async function fixture() {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void handleSessionMutationsRoute({
      requireSessionControl: (id) => calls.push(`control:${id}`),
      beginPromptAdmission: async (id) => { calls.push(`admit:${id}`); return () => calls.push("release"); },
      renameSession: async (id, name) => { calls.push(`rename:${id}:${name}`); return { id, name }; },
      deleteSession: async (id) => { calls.push(`delete:${id}`); return { id }; },
      copySession: async (id, mode) => { calls.push(`copy:${id}:${mode}`); return { session: { id } }; },
    }, request, response, url, "aaaaaaaaaaaaaaaaaaaa").then((handled) => {
      if (!handled) { response.statusCode = 404; response.end(); }
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

test("session mutation route adapter owns rename/delete admission wrapping", async () => {
  const target = await fixture();
  try {
    const id = "0123456789abcdef0123";
    const rename = await fetch(`${target.origin}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    assert.equal(rename.status, 200);
    const deleted = await fetch(`${target.origin}/api/sessions/${id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(target.calls, [
      `control:${id}`, `admit:${id}`, `control:${id}`, `rename:${id}:Renamed`, "release",
      `control:${id}`, `admit:${id}`, `control:${id}`, `delete:${id}`, "release",
    ]);
  } finally {
    await target.close();
  }
});

test("session mutation route adapter forwards Clone without creating a Runtime", async () => {
  const target = await fixture();
  try {
    const id = "0123456789abcdef0123";
    const response = await fetch(`${target.origin}/api/sessions/${id}/clone`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(target.calls, [`copy:${id}:clone`]);
  } finally {
    await target.close();
  }
});
