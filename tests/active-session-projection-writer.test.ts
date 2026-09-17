import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ActiveSessionProjectionWriter } from "../src/web/application/active-session-projection-writer";

function fixture() {
  let runEpochGeneration = 0;
  let projected: string[] = [];
  const writer = new ActiveSessionProjectionWriter(
    (ids) => { projected = ids; },
    () => runEpochGeneration,
  );
  return {
    writer,
    projected: () => projected,
    replaceProcess: () => { runEpochGeneration += 1; },
  };
}

test("current full projection commits and newer SSE rejects an older Bootstrap", () => {
  const { writer, projected } = fixture();
  const bootstrapAuthority = writer.captureAuthority(0);
  assert.equal(writer.commitBootstrap(["primary", "secondary"], bootstrapAuthority), true);
  assert.deepEqual(projected(), ["primary", "secondary"]);

  const heldBootstrap = writer.captureAuthority(0);
  assert.equal(writer.observeSse(["primary"]), true);
  assert.deepEqual(projected(), ["primary"]);
  assert.equal(writer.commitBootstrap(["primary", "secondary"], heldBootstrap), false);
  assert.deepEqual(projected(), ["primary"]);
});

test("an equal SSE snapshot still fences older Bootstrap and view facts", () => {
  const { writer, projected } = fixture();
  writer.observeSse(["primary"]);
  const heldBootstrap = writer.captureAuthority(0);
  const heldView = writer.captureViewAuthority(0, "secondary");

  assert.equal(writer.observeSse(["primary"]), false);
  assert.deepEqual(projected(), ["primary"]);
  assert.equal(
    writer.commitBootstrap(["primary", "secondary"], heldBootstrap),
    false,
  );
  assert.deepEqual(
    writer.reconcileSessionView("secondary", true, heldView),
    { active: false, accepted: false },
  );
});

test("a reclaimed Session cannot return through its older view", () => {
  const { writer, projected } = fixture();
  writer.observeSse(["primary", "secondary"]);
  const viewAuthority = writer.captureViewAuthority(0, "secondary");
  writer.observeSse(["primary"]);

  assert.deepEqual(writer.reconcileSessionView(
    "secondary",
    true,
    viewAuthority,
  ), { active: false, accepted: false });
  assert.deepEqual(projected(), ["primary"]);
});

test("current Session views refine only their own membership", () => {
  const { writer, projected } = fixture();
  writer.observeSse(["primary"]);
  const primaryView = writer.captureViewAuthority(0, "primary");
  const secondaryView = writer.captureViewAuthority(0, "secondary");
  const heldBootstrap = writer.captureAuthority(0);

  assert.deepEqual(writer.reconcileSessionView(
    "secondary",
    true,
    secondaryView,
  ), { active: true, accepted: true });
  assert.deepEqual(projected(), ["primary", "secondary"]);
  assert.deepEqual(writer.reconcileSessionView(
    "primary",
    true,
    primaryView,
  ), { active: true, accepted: true });
  assert.equal(
    writer.commitBootstrap(["primary"], heldBootstrap),
    false,
    "a full response captured before the view refinement is stale",
  );
});

test("same-Session view refinement retires only older reads for that Session", () => {
  const { writer } = fixture();
  writer.observeSse(["primary"]);
  const olderPrimary = writer.captureViewAuthority(0, "primary");
  const secondary = writer.captureViewAuthority(0, "secondary");
  assert.equal(writer.reconcileSessionView(
    "primary",
    false,
    olderPrimary,
  ).accepted, true);
  assert.deepEqual(writer.reconcileSessionView(
    "primary",
    true,
    olderPrimary,
  ), { active: false, accepted: false });
  assert.equal(
    writer.reconcileSessionView("secondary", true, secondary).accepted,
    true,
    "an unrelated Session retains its own read authority",
  );
});

test("cached views consume membership without refining it", () => {
  const { writer, projected } = fixture();
  writer.observeSse(["primary"]);
  assert.deepEqual(
    writer.projectSessionView("secondary"),
    { active: false, accepted: false },
  );
  assert.deepEqual(projected(), ["primary"]);
});

test("draft authority survives unrelated view refinement but not a full snapshot", () => {
  const { writer } = fixture();
  writer.observeSse(["primary"]);
  const draft = writer.captureDraftAuthority(0);
  const secondary = writer.captureViewAuthority(0, "secondary");
  assert.equal(
    writer.reconcileSessionView("secondary", true, secondary).accepted,
    true,
  );
  assert.equal(
    writer.reconcileSessionView("draft-session", true, draft).accepted,
    true,
  );
  const olderDraft = writer.captureDraftAuthority(0);
  writer.observeSse(writer.currentIds());
  assert.equal(
    writer.reconcileSessionView("other-draft", true, olderDraft).accepted,
    false,
  );
});

test("deletion and process replacement retire earlier full and view authority", () => {
  const { writer, projected, replaceProcess } = fixture();
  writer.observeSse(["primary", "secondary"]);
  const full = writer.captureAuthority(0);
  const view = writer.captureViewAuthority(0, "secondary");
  writer.forgetCurrent("secondary");
  assert.deepEqual(projected(), ["primary"]);
  assert.equal(writer.commitBootstrap(["primary", "secondary"], full), false);
  assert.equal(
    writer.reconcileSessionView("secondary", true, view).accepted,
    false,
  );

  const processAuthority = writer.captureAuthority(0);
  replaceProcess();
  writer.resetForReplacement();
  assert.deepEqual(projected(), []);
  assert.equal(writer.commitBootstrap(["primary"], processAuthority), false);
});

test("App routes active-set mutations through the projection writer", async () => {
  const source = await readFile(
    new URL("../src/web/App.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(
    source.match(/setActiveSessionIds\(/g)?.length,
    1,
    "the React setter appears only in the writer sink wiring",
  );
  assert.match(
    source,
    /new ActiveSessionProjectionWriter\([\s\S]*?setActiveSessionIds\(ids\)/,
  );
});
