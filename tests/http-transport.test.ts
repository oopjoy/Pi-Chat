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
