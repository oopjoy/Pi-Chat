import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { idForPath } from "../../src/server/session-index";
import { PiChatApp } from "../../src/server/app";
import type { PromptPersistenceReceipt } from "../../src/server/prompt-receipt";
import type { PiRpcClient } from "../../src/server/rpc-client";
import type { ResourceManager } from "../../src/server/resource-manager";
import type { SessionIndex } from "../../src/server/session-index";
import type { PendingPromptProjection, PiMessage, PromptImage } from "../../src/shared/types";
import { protectTranscriptWithLocalTurns, type LocalUserTurn } from "../../src/web/lib/local-user-turn";
import { FakeRpc } from "../helpers/server-app-fixture";

function fixture() {
  const app = new PiChatApp({
    rpc: new FakeRpc("C:/fixture/image.jsonl", "image") as unknown as PiRpcClient,
    sessions: { list: async () => [], cachedSnapshotForId: () => ({ messages: [], settings: {} }) } as unknown as SessionIndex,
    resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(),
  });
  const projection = app as unknown as {
    recordAcceptedPrompt(id: string, promptId: string, at: number, text: string, images: PromptImage[], settings?: undefined, clientId?: string, receipt?: PromptPersistenceReceipt): void;
    recordPromptReceipt(id: string, promptId: string, receipt: PromptPersistenceReceipt | undefined): void;
    reconcilePendingAcceptedPrompts(id: string, messages: PiMessage[]): void;
    pendingPromptForSession(id: string): PendingPromptProjection | undefined;
    promptPayloadFingerprint(message: PiMessage): string;
  };
  return { app, projection };
}

const image: PromptImage = { type: "image", data: "original-base64", mimeType: "image/png" };
const canonical = (entry: string, timestamp: number, data = "resized-base64"): PiMessage => ({
  role: "user", timestamp, piChatPersistedMessageId: entry,
  content: [{ type: "text", text: "inspect\n\n[Image: original 2550x1214, displayed at 2000x952. Multiply coordinates by 1.27 to map to original image.]" },
    { type: "image", data, mimeType: "image/png" }],
});

function receipt(projection: ReturnType<typeof fixture>["projection"], message: PiMessage): PromptPersistenceReceipt {
  return { version: 1, timestamp: message.timestamp!, payloadFingerprint: projection.promptPayloadFingerprint(message) };
}

test("normalized image persistence retires the raw pending prompt and never restores it after reload", async () => {
  const { app, projection: p } = fixture();
  try {
    const echo = canonical("entry-image:0", 1_100);
    p.recordAcceptedPrompt("session", "prompt-image", 1_000, "inspect", [image], undefined, "operation-image", receipt(p, echo));
    const pending = p.pendingPromptForSession("session")!;
    assert.ok(pending, "acceptance alone is not persisted evidence");
    const local: LocalUserTurn = { sessionId: "session", message: pending.message, serverPromptId: pending.promptId, expectedTurnTotal: 1, baselineTurnTotal: 0 };
    const answer: PiMessage = { role: "assistant", content: "done", timestamp: 2_000, piChatPersistedMessageId: "answer:0" };
    p.reconcilePendingAcceptedPrompts("session", [echo, answer]);
    assert.equal(p.pendingPromptForSession("session"), undefined);
    assert.equal(echo.piChatPromptId, "prompt-image");
    assert.deepEqual(protectTranscriptWithLocalTurns([local], [echo, answer], 2, 1).pendingTurns, []);
    const reread = [echo, answer].map(({ piChatPromptId: _id, ...message }) => message);
    p.reconcilePendingAcceptedPrompts("session", reread);
    assert.equal(reread[0].piChatPromptId, "prompt-image");
    assert.equal(p.pendingPromptForSession("session"), undefined, "F5 must not resurrect the raw image bubble below the answer");
  } finally { await app.close(); }
});

test("image receipt cannot confirm a different image or a different timestamp", async () => {
  const { app, projection: p } = fixture();
  try {
    const expected = canonical("expected:0", 1_100);
    p.recordAcceptedPrompt("session", "p1", 1_000, "inspect", [image], undefined, undefined, receipt(p, expected));
    const wrongImage = canonical("wrong-image:0", 1_100, "different-base64");
    p.reconcilePendingAcceptedPrompts("session", [wrongImage]);
    assert.ok(p.pendingPromptForSession("session"));
    assert.equal(wrongImage.piChatPromptId, undefined);
    const wrongTime = canonical("wrong-time:0", 1_101);
    p.reconcilePendingAcceptedPrompts("session", [wrongTime]);
    assert.ok(p.pendingPromptForSession("session"));
    const rawRow: PiMessage = { role: "user", content: [{ type: "text", text: "inspect" }, image], timestamp: 1_200, piChatPersistedMessageId: "raw-unrelated:0" };
    p.reconcilePendingAcceptedPrompts("session", [rawRow]);
    assert.ok(p.pendingPromptForSession("session"), "once a canonical receipt exists, a raw payload match cannot override it");
    assert.equal(rawRow.piChatPromptId, undefined);
  } finally { await app.close(); }
});

test("late receipt resolves an uncertain image admission only after exact persisted evidence", async () => {
  const { app, projection: p } = fixture();
  try {
    const echo = canonical("late:0", 1_100);
    p.recordAcceptedPrompt("session", "late-prompt", 1_000, "inspect", [image]);
    p.reconcilePendingAcceptedPrompts("session", [echo]);
    assert.ok(p.pendingPromptForSession("session"), "a transformed row without a request witness must not clear uncertainty");
    p.recordPromptReceipt("other-session", "late-prompt", receipt(p, echo));
    p.recordPromptReceipt("session", "other-prompt", receipt(p, echo));
    p.reconcilePendingAcceptedPrompts("session", [echo]);
    assert.ok(p.pendingPromptForSession("session"));
    p.recordPromptReceipt("session", "late-prompt", receipt(p, echo));
    assert.ok(p.pendingPromptForSession("session"), "a receipt alone never certifies persistence");
    p.reconcilePendingAcceptedPrompts("session", [echo]);
    assert.equal(p.pendingPromptForSession("session"), undefined);
    p.recordPromptReceipt("session", "late-prompt", receipt(p, echo));
    assert.equal(p.pendingPromptForSession("session"), undefined, "late metadata cannot recreate a retired prompt");
  } finally { await app.close(); }
});

test("image-only prompts use the native placeholder and retain rewritten-file protection", async () => {
  const { app, projection: p } = fixture();
  try {
    const echo = canonical("image-only:0", 1_100);
    echo.content = [{ type: "text", text: "请查看这些图片。\n\n[Image: resized by Pi]" }, { type: "image", data: "resized", mimeType: "image/jpeg" }];
    p.recordAcceptedPrompt("session", "image-only", 1_000, "", [image], undefined, undefined, receipt(p, echo));
    p.reconcilePendingAcceptedPrompts("session", [echo]);
    assert.equal(echo.piChatPromptId, "image-only");
    assert.equal(p.pendingPromptForSession("session"), undefined);
    const rewritten = { ...echo, piChatPromptId: undefined, content: "external rewrite" };
    p.reconcilePendingAcceptedPrompts("session", [rewritten]);
    assert.equal(rewritten.piChatPromptId, undefined, "a reused JSONL entry id cannot inherit the old Prompt claim");
  } finally { await app.close(); }
});

test("image-only New submission retains its Prompt id and routes the native receipt into reconciliation", async () => {
  const primaryPath = "C:/fixture/primary.jsonl";
  const draftPath = "C:/fixture/draft.jsonl";
  const primaryId = idForPath(primaryPath);
  const primary = new FakeRpc(primaryPath, "primary");
  const draft = new FakeRpc(draftPath, "draft");
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient, createRpc: () => draft as unknown as PiRpcClient,
    sessions: {
      list: async () => [{ id: primaryId, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
      pathForId: () => primaryPath, summaryForId: () => null, messagesForId: async () => [],
    } as unknown as SessionIndex,
    resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(),
  });
  const p = app as unknown as ReturnType<typeof fixture>["projection"];
  const originalSend = draft.send.bind(draft);
  let echo: PiMessage | undefined;
  draft.send = async (...args: Parameters<FakeRpc["send"]>) => {
    const result = await originalSend(...args);
    if (args[0].type === "prompt" && Array.isArray(args[0].images)) {
      echo = canonical("draft-user:0", Date.now());
      return { ...result, command: "prompt", data: { disposition: "started", piChatUserMessage: receipt(p, echo) } };
    }
    return result;
  };
  const server = createServer((request, response) => { void app.handle(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(origin + "/api/bootstrap");
    const response = await fetch(origin + "/api/sessions/new", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ initial: { message: "", images: [{ ...image, data: "AAAA" }] } }),
    });
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.ok(body.promptId, "an image-only first turn needs the same stable Prompt identity as text");
    assert.ok(echo);
    assert.ok(p.pendingPromptForSession(body.session.id));
    p.reconcilePendingAcceptedPrompts(body.session.id, [echo]);
    assert.equal(echo.piChatPromptId, body.promptId);
    assert.equal(p.pendingPromptForSession(body.session.id), undefined);
  } finally { server.close(); await app.close(); }
});

test("identical normalized image prompts retain distinct request identities", async () => {
  const { app, projection: p } = fixture();
  try {
    const first = canonical("first:0", 1_100);
    const second = canonical("second:0", 1_300);
    p.recordAcceptedPrompt("session", "p1", 1_000, "inspect", [image], undefined, undefined, receipt(p, first));
    p.recordAcceptedPrompt("session", "p2", 1_200, "inspect", [image], undefined, undefined, receipt(p, second));
    p.reconcilePendingAcceptedPrompts("session", [first]);
    assert.equal(first.piChatPromptId, "p1");
    assert.equal(p.pendingPromptForSession("session")?.promptId, "p2");
    p.reconcilePendingAcceptedPrompts("session", [first, second]);
    assert.equal(second.piChatPromptId, "p2");
    assert.equal(p.pendingPromptForSession("session"), undefined);
  } finally { await app.close(); }
});
