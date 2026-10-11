// Compile-only contract tests. `npm run typecheck` runs this file through tsc;
// tsx execution would not validate @ts-expect-error and is deliberately not used.
import type { SessionViewData } from "../../src/shared/types";
import { SessionViewCacheWriter } from "../../src/web/application/session-view-cache-writer";
import { RuntimeProjectionWriter } from "../../src/web/application/runtime-projection-writer";
import { ActiveSessionProjectionWriter } from "../../src/web/application/active-session-projection-writer";

declare const cache: SessionViewCacheWriter;
declare const runtime: RuntimeProjectionWriter;
declare const active: ActiveSessionProjectionWriter;
declare const view: SessionViewData;
const cacheAuthority = cache.captureAuthority(1);
const runtimeAuthority = runtime.captureAuthority(1);
const activeAuthority = active.captureAuthority(1);
cache.remember(view, cacheAuthority);
runtime.commitBootstrap({ readiness: { status: "ready", generation: 1 }, lifecycle: "idle" }, runtimeAuthority);
active.commitBootstrap(["session"], activeAuthority);

// @ts-expect-error Runtime authority cannot authorize a cache write.
cache.remember(view, runtimeAuthority);
// @ts-expect-error A cache token cannot authorize the Runtime projection.
runtime.commitBootstrap({ readiness: { status: "ready", generation: 1 }, lifecycle: "idle" }, cacheAuthority);
// @ts-expect-error Runtime authority cannot authorize the hot Session set.
active.commitBootstrap(["session"], runtimeAuthority);
// @ts-expect-error Async cache writes require an explicit authority.
cache.remember(view);
// @ts-expect-error The storage object is not exposed as a public mutation port.
cache.cache.clear();
// @ts-expect-error Readiness must contain a generation.
runtime.observeTransportReady({ status: "ready" });
// @ts-expect-error Missing a required sink is not valid writer wiring.
new RuntimeProjectionWriter({ readiness() {}, capability() {} }, () => 1);
