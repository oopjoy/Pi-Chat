# Active-Session projection checkpoint

This checkpoint records the bounded authority phase merged at `9b8cccf`. It is
separate from `RuntimeProjectionWriter`: the hot Session set, Runtime operation
admission, and model catalogue are different facts with different owners.

## Browser hot-Session projection

`ActiveSessionProjectionWriter` is the sole browser mutation/freshness boundary
for `activeSessionIds`. Its sink wires the accepted set to React state, cache
pins, and sidebar writable flags.

The owner distinguishes three revision scopes:

- `runEpochGeneration` rejects facts from a replaced Pi Chat process;
- `activeSessionProjectionGeneration` advances for every full Bootstrap/SSE
  observation, including an equal-set SSE frame;
- per-Session revisions allow one authoritative HTTP view to refine only its
  target without invalidating unrelated Session reads.

A full-set revision also fences held Bootstrap responses. Structural deletion
retires the deleted Session's reads and older full snapshots. Browser-cache
views are consumers only: a freshly selected cached transcript cannot promote
its historical `isActive` value back into the hot set.

A stale HTTP view is still allowed to paint valid JSONL/transcript content after
normal Pane/cache authority checks, but its Runtime fields are normalized to the
writer's current membership. Reclaimed Sessions therefore remain view-only and
must acquire Runtime capability again on the next write.

## Server hot-read admission

Primary and Secondary hot Session reads now hold the same `OperationAdmission`
leases used by mutation and lifecycle paths:

- Primary reads acquire `primaryOperationAdmission`;
- Secondary reads acquire through `RuntimePool.acquireOperation`;
- reclaim/rest/reload closes admission and drains admitted reads before stopping
  a child;
- after every awaited disk/RPC/statistics boundary, the read revalidates Runtime
  identity, RPC generation, admission generation, and process liveness;
- Fork-origin lookup remains inside the read lease.

If revalidation fails, a normal view discards the hot projection and re-reads a
JSONL-only view. A fast hot-memory request fails with `HOT_VIEW_UNAVAILABLE`
instead of pretending a detached Runtime is active.

This admission does not make reads Runtime authorities. Reads may update only
existing bounded observational snapshots while their lease remains current.
Cold history still starts no Runtime and performs no Runtime RPC.

## Model catalogue ordering

`ModelCatalogueRevisionGate` admits browser catalogue snapshots without owning
catalogue UI state. The server's `modelCatalogueRevision` is process-local:

- lower HTTP or SSE revisions are rejected;
- ordered SSE may refine the same revision, for example host discovery followed
  by Runtime synchronization;
- a Bootstrap at the same revision must still hold the local observation
  generation captured when its request began;
- a numerically newer same-process Bootstrap may advance the catalogue even if
  another observation completed first;
- mutation responses without captured authority must be strictly newer once a
  revisioned projection exists;
- process replacement resets the server revision floor and advances a separate
  process generation, so old-process authority cannot authorize the
  replacement's lower revision.

Legacy unrevisioned Bootstrap remains accepted only while no revisioned server
fact has been observed. It cannot overwrite revisioned state.

## Regression coverage

Focused tests cover:

- changed-set and equal-set reclaim SSE versus held Bootstrap/view responses;
- cache navigation after reclaim;
- unrelated per-Session refinements and draft authority;
- deletion and process replacement;
- Primary/Secondary admission drain and JSONL fallback;
- revalidation across held Fork-origin lookup;
- equal-revision model SSE refinement, lower revision rejection, and lower
  replacement-process revision acceptance.

## Verification

The merged source checkpoint passed:

```text
typecheck                         passed
source single-process             1249 passed, 2 environment skips
preflight                         86 passed
isolated staged E2E               25 passed
isolated staged artifact          41 passed, 1 environment skip
PR Windows CI                     passed
post-merge main Windows CI        passed
```

The phase did not use the live Pi Runtime, providers, live Sessions, port
`30170`, deployment, or the repository/live `dist`. Package and lockfile
identity remain `0.4.7`; published `v0.4.6` and `v0.4.7` tags did not move.

## Maintenance handoff

The duplicated source-test exclusion lists were subsequently removed: the
single-process, batched, benchmark, and artifact entry points now consume the
shared lane manifests, with exact disjoint-union regression coverage.

This closes the planned authority-convergence phase. Active architecture work
is frozen: future structural changes require a reproduced defect, release or
security need, or measurement evidence. Performance checkpoints remain
descriptive rather than noisy CI thresholds.

Do not fold these owners into `RuntimeProjectionWriter`, and do not turn
`App.tsx` wiring into a second hot-set, read-lifecycle, or catalogue authority.
