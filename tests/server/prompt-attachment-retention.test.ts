import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { DroppedFileStore } from "../../src/server/dropped-files";
import { handlePromptRoute, type PromptRouteHost } from "../../src/server/routes/prompt-route";
import { handleNewSessionRoute, type NewSessionRouteHost } from "../../src/server/routes/new-session";

const request = { method: "POST" } as IncomingMessage;
const response = {} as ServerResponse;

test("direct Prompt API retention does not depend on the browser preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-prompt-attachment-"));
  const store = new DroppedFileStore(join(root, "attachments"));
  const boundary = new Error("stop at the pre-dispatch boundary");
  try {
    const path = await store.stage("my paper.pdf", Buffer.from("pdf"), "owner");
    const host = {
      options: { attachmentStore: store },
      nextUserPromptAt: () => { throw boundary; },
    } as unknown as PromptRouteHost;
    await assert.rejects(handlePromptRoute(host, request, response, new URL("http://localhost/api/chat/prompt"), {
      message: `Read this\r\n[Attached files]\r\n"${path}"`, sessionId: "00000000000000000001",
    }), (error) => error === boundary);
    await store.discard(path, "owner", 1);
    await access(path);
    assert.equal((await store.maintain()).retained, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing managed attachments reject before a Prompt dispatch or New Session allocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-missing-attachment-"));
  const store = new DroppedFileStore(join(root, "attachments"));
  try {
    const path = await store.stage("gone.txt", Buffer.from("gone"), "owner");
    await store.discard(path, "owner", 1);
    let dispatched = false;
    const message = `Read\n[Attached files]\n"${path}"`;
    const isPreflight = (error: unknown) => Boolean(error && typeof error === "object" && "status" in error
      && error.status === 400 && "code" in error && error.code === "ATTACHMENT_UNAVAILABLE");
    await assert.rejects(handlePromptRoute({
      options: { attachmentStore: store },
      nextUserPromptAt: () => { dispatched = true; return Date.now(); },
    } as unknown as PromptRouteHost, request, response, new URL("http://localhost/api/chat/prompt"), {
      message, sessionId: "00000000000000000001",
    }), isPreflight);
    await assert.rejects(handleNewSessionRoute({
      currentCwd: () => root,
      retainPromptAttachments: (text) => store.retainPrompt(text),
      primaryNeedsRecovery: () => { dispatched = true; return false; },
    } as NewSessionRouteHost, request, response, new URL("http://localhost/api/sessions/new"), "client", {
      initial: { message },
    }), isPreflight);
    assert.equal(dispatched, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
