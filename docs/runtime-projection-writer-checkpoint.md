# Primary Runtime projection writer checkpoint

This note records the browser-side Primary Runtime projection boundary merged at
`e56ddccc0bcb851f94938f46051bb2e6c0b9f73c` and its descriptive performance
comparison against `80aeac2c85f8bca57c89fa303e082f797b9d541a`.

## Scope

`RuntimeProjectionWriter` is the sole browser write boundary for three
application-global projections:

- Primary Runtime readiness (`starting`, `ready`, or `failed`);
- confirmed model capability evidence for the current readiness generation;
- application lifecycle (`idle`, restart, shutdown, workspace change, resource
  reload, or model refresh).

These are projections of server/Runtime facts. They do not own Runtime startup,
Pi RPC, Session JSONL, Prompt admission, retry policy, Session navigation, or
Pane state.

Commands, model inventory, active Session IDs, Session inventory, workspace
metadata, and cache pinning remain with their existing owners. Mutation
responses may reconcile that ancillary metadata, but they do not carry ordered
core Runtime projection authority.

## Authority contract

Every asynchronous core Runtime write carries:

```text
runEpochGeneration
runtimeProjectionGeneration
```

`runEpochGeneration` fences a replacement Pi Chat process. The
`runtimeProjectionGeneration` fences newer same-process Runtime facts and
resource-reload boundaries.

The writer applies these rules:

1. accepted synchronous readiness, capability, or lifecycle changes advance the
   projection generation;
2. duplicate or malformed observations do not advance it;
3. an asynchronous bootstrap commits only with current authority and a
   non-regressing readiness generation;
4. equal-generation `starting` cannot erase equal-generation `ready` or
   `failed` state;
5. equal-generation refinements to model, Session, Thinking, incident, or error
   facts are admitted and advance authority;
6. capability evidence must name the current ready generation and a model in
   the committed catalogue;
7. process replacement resets process-local readiness to generation zero;
8. resource reload clears readiness/capability while retaining the admitted
   maintenance lifecycle until an explicit `idle` fact.

Bootstrap request coalescing is keyed by process, Session-cache, and Runtime
projection generations. A newer observation therefore starts a fresh request
instead of granting a held older request newly captured authority. Request
finalizers are identity-guarded so an older completion cannot detach the newer
request.

A recovered transport token is treated conservatively as a possible process
replacement before its recovery bootstrap. This permits a replacement process
with a lower process-local readiness generation to become authoritative even
when no replacement ready frame survived the disconnect.

Lifecycle parsing is fail-closed. Dedicated lifecycle frames and EventSource
ready snapshots must carry a member of the closed lifecycle vocabulary before
any process, readiness, capability, or lifecycle side effect occurs. A legacy
bootstrap may default only a strictly absent lifecycle to `idle`; malformed
values are not coerced.

`resources-reloading` in a ready snapshot is a self-contained replacement
boundary because a reconnect may have missed its earlier lifecycle edge and
reload marker. `models-refreshing` is not such evidence: model-file
transactions use that lifecycle without replacing a Runtime, so it locks the
application but does not clear valid Runtime or Session projections.

## Validation checkpoint

The boundary passed:

- read-only independent authority and React-integration review;
- focused Runtime/reload/replacement/lifecycle tests;
- source suite: 1,225 passed and two environment skips;
- preflight: 86 of 86;
- isolated staged Playwright: 25 of 25;
- isolated staged artifact verification: 41 passed and one environment skip;
- pull-request and post-merge Windows CI;
- committed-text, typecheck, diff, package identity, and unchanged-tag checks.

The pull request and CI evidence are:

- PR: <https://github.com/oopjoy/Pi-Chat/pull/3>
- PR CI: <https://github.com/oopjoy/Pi-Chat/actions/runs/35185557291>
- post-merge CI: <https://github.com/oopjoy/Pi-Chat/actions/runs/35186102038>

No live Runtime, provider, Prompt, Session, deployment, port 30170, personal
Session root, or repository/live `dist` was used.

## Descriptive performance comparison

Both checkpoints used Node `v24.16.0`, headless Chromium `151.0.7922.34`, the
same deterministic fixture hashes, and the same streaming harness hash. Each
browser/streaming cell used three iterations. These are samples, not release
thresholds or causal performance claims.

### Browser fluency

| Scenario | Before median | After median | Delta |
|---|---:|---:|---:|
| cold first pane | 48.5 ms | 44.4 ms | -4.1 ms |
| hot switch | 20.1 ms | 27.8 ms | +7.7 ms |
| load earlier | 38.4 ms | 38.5 ms | +0.1 ms |

Median DOM counts remained 498, 498, and 798 respectively. Median Long Task
duration remained zero, and the load-earlier median anchor error remained zero.

### Session readers

The `$128$ MiB` full-snapshot lane showed mixed timing movement: parse median
rose from 283.623 ms to 381.754 ms, snapshot-miss median rose by 34.604 ms, and
snapshot-hit median rose by 143.414 ms, while discovery-miss median fell by
1.767 ms and recent-window median fell by 0.039 ms. The writer change does not
modify Session parsing or snapshot algorithms, so this small run is retained as
noise-sensitive evidence rather than attributed to the refactor.

The `$256$ MiB` bounded-tail lane preserved the 262,144-byte read bound and the
same fixture hash. Median recent-10 and recent-50 reads moved from 1.108 ms and
1.467 ms to 0.839 ms and 0.845 ms. Four-read concurrent batch median moved from
2.292 ms to 1.435 ms. Runner peak RSS increased by 3,182,592 bytes.

### Streaming cadence

All 12 cells completed with matching harness identity and comparison-ready
three-iteration cycles. Across cells, median first-visible observation deltas
ranged from -1.9 ms to +7.1 ms, and first paint-opportunity deltas ranged from
-4.0 ms to +7.2 ms. Message-end paint-opportunity deltas ranged from +13.3 ms
to +58.2 ms; one cell also recorded a 66.6 ms larger median maximum frame gap.
These mixed scheduler-sensitive samples do not justify a threshold or a claim
that the authority refactor changed streaming performance.

The uncommitted audit artifacts and their SHA-256 manifest are retained outside
the repository at:

```text
C:/Users/opjoy/AppData/Local/Temp/pi-chat-benchmark-checkpoints/80aeac2
C:/Users/opjoy/AppData/Local/Temp/pi-chat-benchmark-checkpoints/e56ddcc
```

## Subsequent bounded authority phase

This writer checkpoint does not claim whole-application async convergence. The
three independent follow-up boundaries were completed at `9b8cccf`:

1. `ActiveSessionProjectionWriter` fences Bootstrap, SSE, authoritative HTTP
   views, cached-view consumers, deletion, and process replacement;
2. Primary and Secondary hot reads hold Runtime operation admission and
   revalidate after awaited probes and Fork-origin reads;
3. `ModelCatalogueRevisionGate` admits Bootstrap, model-management, and
   `pi_chat_models_updated` by process-local revision plus a same-revision local
   observation fence.

The resulting contract and focused race validation are recorded in
[`active-session-projection-checkpoint.md`](active-session-projection-checkpoint.md).
These owners remain separate from `RuntimeProjectionWriter`.

The final explicit cleanup is also complete: batched and single-process source
selection consume the same generated lane manifest, and source, benchmark, and
artifact membership has exact disjoint-union regression coverage.
