# Routed-response lifetime investigation — 2026-10-15

## Failure and correction

Windows CI run `38671496728`, attempt 1, failed in the queued-turn ownership
scenario at `APIResponse.json()` with `Response has been disposed`.

The initial patch (`13b1e66`) caught errors matching `disposed|abort`. That was
not a demonstrated root-cause fix and could suppress unrelated failures. This
follow-up removes it. HTTP status assertions, JSON decoding, and route fulfillment
are again unconditional; their errors must fail the test.

In the installed Playwright 1.62 implementation, fetched response bodies live in
`APIRequestContext.fetchResponses`. Context disposal clears that map. A subsequent
body read reports the observed disposal error. Browser fetch cancellation alone
is not proof that the APIResponse was disposed.

## Deterministic controls

`e2e/route-lifecycle.spec.ts` holds a route after `route.fetch()` and before body
consumption, using promise barriers rather than timing sleeps:

- Browser AbortController cancellation: the fetched body remains readable.
- Page reload: the fetched body remains readable while the context is alive.
- `page.unrouteAll({ behavior: "wait" })`: waits for the held callback to read and
  fulfill its response before completing.
- Explicit BrowserContext disposal: a subsequent response JSON read deterministically
  reproduces the CI error.

These controls establish a concrete teardown race and its lifecycle fix. The old
CI log did not record every teardown event, so it cannot prove the historical
interleaving by itself.

## Fix and validation

The shared `page` fixture unregisters routes with `behavior: "wait"` in its
`finally` block, before Playwright's underlying context fixture disposes responses.
It does not use `ignoreErrors`, enlarge retries, or suppress handler exceptions.
The existing test/teardown deadline still bounds a stuck handler and fails the run.

With a freshly staged build (not the user's live `dist`):

- All four controls passed five repetitions: 20 checks.
- The original queued-turn scenario passed 20 repetitions without the catch.

Repetition is supporting evidence, not a guarantee that all E2E flakes are gone.

## Diagnostic isolation

The E2E wrapper previously inherited `LOCALAPPDATA`, so fake Runtime starts could
append to and rotate the user's real incident logs. Its child now receives
`LOCALAPPDATA` and `XDG_STATE_HOME` inside the fixture-owned temporary root.
Production logs must not be treated as exclusively live evidence when examining
older runs; filter by host/span and actual extension activity, not revision alone.
