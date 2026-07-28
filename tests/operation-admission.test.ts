import assert from "node:assert/strict";
import test from "node:test";
import { OperationAdmission, OperationAdmissionClosedError } from "../src/server/operation-admission";

test("closing admission blocks new operations and waits for admitted work", async () => {
  const admission = new OperationAdmission();
  const first = admission.acquire();
  let drained = false;
  const closing = admission.closeAndDrain().then((generation) => {
    drained = true;
    return generation;
  });

  assert.equal(admission.isClosed, true);
  assert.equal(drained, false);
  assert.throws(() => admission.acquire(), OperationAdmissionClosedError);
  first.release();
  const generation = await closing;
  assert.equal(drained, true);
  assert.equal(typeof generation, "number");
  admission.reopen(generation as number);
  assert.equal(admission.isClosed, false);
  admission.acquire().release();
});

test("only the matching close generation can reopen admission", async () => {
  const admission = new OperationAdmission();
  const generation = await admission.closeAndDrain();
  assert.ok(generation !== null);
  admission.reopen((generation as number) - 1);
  assert.equal(admission.isClosed, true);
  admission.reopen(generation as number);
  assert.equal(admission.isClosed, false);
});
