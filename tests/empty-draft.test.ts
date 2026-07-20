import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import type { PiRpcClient } from "../src/server/rpc-client";
import type { ResourceManager } from "../src/server/resource-manager";
import type { SessionIndex } from "../src/server/session-index";
import { idForPath } from "../src/server/session-index";

const draftPath = "C:\\sessions\\unstarted-draft.jsonl";
const savedPath = "C:\\sessions\\saved.jsonl";

test("an empty active draft stays in the main composer but is absent from sidebar sessions", async () => {
  const rpc = {
    onEvent: () => () => {},
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: draftPath, sessionId: "draft", messageCount: 0, isStreaming: false } };
      if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
      if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
      if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
      if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      throw new Error(`Unexpected RPC command: ${String(command.type)}`);
    },
  } as unknown as PiRpcClient;
  const sessions = {
    list: async () => [{ id: idForPath(savedPath), sessionId: "saved", name: "Saved", preview: "question", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false }],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const data = await (await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`)).json() as { activeSessionId: string; messages: unknown[]; sessions: Array<{ id: string; name: string; messageCount: number }> };
    assert.equal(data.activeSessionId, idForPath(draftPath));
    assert.deepEqual(data.messages, []);
    assert.deepEqual(data.sessions.map((session) => ({ id: session.id, name: session.name, messageCount: session.messageCount })), [{ id: idForPath(savedPath), name: "Saved", messageCount: 1 }]);
  } finally {
    server.close();
    await app.close();
  }
});
