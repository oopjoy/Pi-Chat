import assert from "node:assert/strict";
import test from "node:test";
import { bodyJson, HttpRequestError } from "../src/server/http-transport";

function delayedBody(delayMs: number, value: string): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield Buffer.from(value);
    },
  };
}

test("bodyJson rejects a stalled request body before an admission lease can be held", async () => {
  await assert.rejects(
    bodyJson(delayedBody(40, "{}") as never, 1_000, 5),
    (error) => error instanceof HttpRequestError && error.status === 408,
  );
});

test("bodyJson still parses complete request bodies within the deadline", async () => {
  assert.deepEqual(
    await bodyJson(delayedBody(0, JSON.stringify({ ok: true })) as never, 1_000, 100),
    { ok: true },
  );
});

test("bodyJson bounds the post-timeout drain and destroys a never-ending request", async () => {
  let destroyed = false;
  const request = {
    complete: false,
    destroyed: false,
    destroy() {
      destroyed = true;
      this.destroyed = true;
      return this;
    },
    async *[Symbol.asyncIterator]() {
      while (!this.destroyed) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!this.destroyed) yield Buffer.from("slow");
      }
    },
  };
  await assert.rejects(
    bodyJson(request as never, 1_000, 5, 10),
    (error) => error instanceof HttpRequestError && error.status === 408,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(destroyed, true, "a peer that never finishes the body cannot retain the request forever");
});
