# Pi Chat v0.4.8

## Windows-first maintenance release

Pi Chat v0.4.8 is the formal maintenance checkpoint after the 0.4.7 stability
preview. It preserves Pi as the sole Runtime, Session/JSONL, Prompt, retry,
Steer, tool, model, and transcript authority while closing the browser and
server continuation races found during the 0.4.x convergence audit.

This is not a 1.0 or remote multi-user release. Pi Chat remains loopback-only,
local-first, and Windows-first.

The runnable Windows package is:

```text
pi-chat-windows-0.4.8.zip
```

The ZIP, portable SHA-256 record, and manifest are generated from the same
`v0.4.8` source revision. The GitHub release records the exact checksum from the
verified release artifact.

## Included

- One browser owner for Session-view cache writes, overlays, deletion fencing,
  and replacement invalidation.
- `RuntimeProjectionWriter` as the sole browser write/freshness boundary for
  Primary readiness, confirmed capability evidence, and application lifecycle.
- `ActiveSessionProjectionWriter` fencing held Bootstrap, stale HTTP views,
  cached hot views, deletion, equal-set SSE observations, and process
  replacement.
- Runtime operation admission for Primary and Secondary hot Session reads,
  including revalidation across RPC, disk, statistics, and Fork-origin awaits.
  Detached reads fall back to JSONL-only state rather than reviving writable
  Runtime authority.
- `ModelCatalogueRevisionGate` ordering Bootstrap, model-management responses,
  and catalogue SSE facts across same-revision refinements and process
  replacement.
- Server-owned Prompt identity, shared-write FIFO, retry projection, uncertain
  delivery, Session replacement/deletion, and navigation fencing retained from
  the 0.4.7 stability work.
- One generated source/benchmark/artifact lane manifest. Single-process and
  batched source tests no longer maintain divergent exclusion lists;
  `bounded-tail-benchmark.test.ts` belongs only to the benchmark lane.
- Proactive architecture work is frozen. Future structural changes require a
  reproduced defect, release/security need, or repeatable measurement evidence.

## Verification

The release candidate passed on Windows using isolated staging paths and
fixtures:

```text
typecheck                                      passed
source, single process                         1,247 passed; 2 environment skips
source, 20 fresh-process batches               all 162 files passed
benchmark                                      33 of 33
preflight                                      86 of 86
Runtime/reconnect/reload/reclaim/shutdown       63 of 63
Playwright, isolated staged build              25 of 25
artifact/startup smoke, isolated staged build  41 passed; 1 environment skip
```

A three-iteration Chromium checkpoint was retained as descriptive evidence only:

```text
cold-first-pane p50  44.50 ms
hot-switch p50       30.70 ms
load-earlier p50     37.40 ms
anchor error p50      0.00 px
```

No noisy performance CI thresholds were added. No live Pi Chat listener,
repository/live `dist`, provider, Prompt, or personal Session root was used by
this checkpoint.

## Known boundaries

- Real-provider failure, throttling, timeout, and native retry still require
  dedicated provider-level field validation.
- No remote access mode is provided.
- No open-source license has been selected; this release does not grant an
  MIT, Apache-2.0, or other open-source redistribution license.
- The source archive is source-only. Use the Windows ZIP for the runnable
  packaged application.

## Installation

1. Install Node.js 22.19 or newer.
2. Install and authenticate Pi 0.85.1 or a compatible Pi with the required RPC
   surface.
3. Download `pi-chat-windows-0.4.8.zip` and its checksum sidecar.
4. Verify the checksum, extract the ZIP, and run `start-pi-chat.cmd` or
   `start-pi-chat-ui.ps1`.
5. Open the loopback listener shown by the launcher, normally
   `http://127.0.0.1:30170`.

See [`README.md`](README.md), [`SECURITY.md`](SECURITY.md), and
[`docs/architecture.md`](docs/architecture.md) for operating and security
boundaries.
