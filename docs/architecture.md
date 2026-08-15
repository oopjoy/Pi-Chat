# Pi Chat Architecture

## Product identity

Pi Chat is a **local-first Web/PWA client for Pi RPC**.

It connects a browser (or installed standalone window) to a globally installed `pi --mode rpc` process through a loopback HTTP API and SSE. Pi remains the authority for agent loop, models, tools, skills, and extensions. Pi Chat provides presentation, session navigation, and the local coordination required for safe multi-window use.

Pi Chat is **not**:

- an Electron/Chromium desktop runtime;
- a reimplementation of the Pi agent kernel;
- a remote multi-user service;
- a plugin marketplace or second agent platform.

“Lightweight” only means the browser runtime is not bundled. Application lifecycle, multi-session coordination, and Windows launchers may still be non-trivial.

## Process layers

Three lifetimes must stay distinct:

| Layer | Owns | Stopped by |
|---|---|---|
| Browser / PWA window | UI, EventSource, local preferences | Window close |
| Pi Chat Node service | HTTP, SSE, Runtime pool, lifecycle barrier | “关闭 Pi Chat” / process exit / 最后窗口关闭后的 quiescent auto-shutdown |
| Pi RPC Runtime | One session JSONL writer, model stream, tools | Service rest / reclaim / shutdown |

Closing a browser window is distinct from an SSE/EventSource drop. An SSE/EventSource drop is reconnectable transport state, not evidence that a window or service has closed: it only follows the delayed Session-control release path. Repeated handshakes from an already SSE-confirmed page retain that durable page lease and can never downgrade it to a temporary pre-SSE record. Because Chromium/PWA lifecycle events may also represent background freezing or renderer discard, only an `unload` beacon carrying foreground close intent latched during `beforeunload`, while the server still holds a fresh foreground-presence lease, may remove the final page and request automatic shutdown. Pi Chat then waits for all generation, queue, confirmation, recovery, Runtime transition, and mutation work to finish and requires a continuous $10$ second quiescent grace before stopping hosted RPC workers and the Node service. A replacement page cancels that grace; stale close beacons cannot remove a replacement page. Explicit close API, restart handoff, and process signals remain independent shutdown paths.

## Hard product boundaries (0.4.x)

The status of each current capability is tracked in [`feature-surface.md`](feature-surface.md). A capability marked removed there must not retain a hidden route, browser wrapper, shared type, or feature-specific regression test.

### In scope

- Chat UI, streaming, markdown, attachments
- Session-first list and cold JSONL history view; on-demand Runtime activation
- At most 5 hot conversations total: Primary + at most 4 Secondary Runtimes
- Multi-window observation with single-writer control
- Gate confirmation UX
- Models list / custom models
- Skills / Extensions / Packages management **as currently implemented** (maintain, do not deepen into a package platform)
- Staging restart and conservative single-file resource rollback
- Windows portable launchers and PWA/Web shortcuts

### Explicit non-goals / pseudo-requirements

- **Remote access** — not a current product need. No half-open host escape hatch. Future remote would require a dedicated design (auth, HTTPS, audit), not `PI_CHAT_ALLOW_REMOTE` style switches.
- Electron shell
- Rewriting agent orchestration inside Pi Chat
- Public internet exposure

### Workspace defaults and local automation surface

The Settings panel exposes `POST /api/workspace/pick` as the sole browser control for choosing the persisted default cwd for future drafts. New-draft UI also exposes `POST /api/workspace/draft-pick` for one draft only. `POST /api/workspace/set` remains a **local automation** API for scripts or a future local CLI, with no browser wrapper. All global/default paths affect only future drafts and directory indexing; they never stop, restart, rebind, or change the cwd of a live Runtime. Do not document `workspace/set` as a remote client entry.

## Server module map

Current ownership still centers on `src/server/app.ts` (`PiChatApp`), with progressive state extraction. Already extracted:

| Module | Responsibility |
|---|---|
| `application-lifecycle.ts` | Barrier states, mutation admission leases |
| `http-transport.ts` | JSON bodies, headers, MIME helpers |
| `pi-data.ts` | RPC payload decoding, message windowing |
| `file-transaction.ts` | Atomic write + snapshot restore |
| `session-index.ts` | JSONL index, cold snapshots, usage |
| `application-restart.ts` | Staging build, promote, handoff |
| `rpc-client.ts` | Global Pi process transport + capability probe |
| `primary-runtime-readiness.ts` | Primary start/recovery, compatibility gate, readiness generations |
| `runtime-pool.ts` | Secondary Runtime maps, capacity mutex, ensure/draft/recover/reclaim/sweep/stopAll |
| `session-control.ts` | Multi-window presence, exclusive control owner, delayed release timers |
| `prompt-scheduler.ts` | Primary queue/dispatch, secondary queue dispatch, enqueue limits |
| `sse-hub.ts` | SSE client map, broadcast / broadcastEach, and payload-free delivery-outcome observation after throttle/backpressure/oversize decisions |
| `runtime-event-transition.ts` | Pure shared event-derived Runtime projection; no transport, timer, queue, binding, or provenance ownership |
| `state-diagnostics.ts` | Always-on, bounded five-minute in-memory flight recorder for closed-schema server API/RPC/SSE/projection facts; export is read-only and owns no Runtime, transport, window, or Session authority |
| `routes/bootstrap.ts` | Health, handshake, bootstrap HTTP parsing/serialization through explicit App capabilities |
| `routes/sessions-read.ts` | Read-only Session list/view HTTP parsing/serialization through explicit App capabilities |
| `api-route-admission.ts` | Pure lifecycle admission classification and prompt body-size policy |

### Extraction order

Extract **state ownership**, not only functions:

1. **RuntimePool** — done (`runtime-pool.ts`)
2. **SessionControl / WindowPresence** — done (`session-control.ts`)
3. **PromptScheduler** — done (`prompt-scheduler.ts`); primary/secondary queue + dispatch
4. **SseHub** — done (`sse-hub.ts`); subscribe/broadcast only
5. **HttpRoutes** — completed for this refactor wave: bootstrap and read-only Session route domains are extracted; the remaining mutation, chat/queue, model/settings, resource, transport streaming, and lifecycle routes were ownership-audited and intentionally remain in `app.ts`

Acceptance for a real extraction:

- Maps for runtimes / controllers are private to their owner module
- Routes receive explicit named capabilities and never mutate runtime/controller/SSE maps directly
- Runtime event transition remains pure; binding checks, queue drains, timer ownership, snapshot warming, and Primary/Secondary lifecycle differences remain in `PiChatApp`
- RuntimePool never imports `IncomingMessage` / `ServerResponse`
- Domain modules are unit-testable without a full HTTP server

Step 5 is complete without moving every URL. Further route movement was rejected where a transport-only adapter would require a wide capability facade, expose private Runtime/control/queue/lifecycle authority, or increase total production code without removing duplicate policy. In particular, SSE/presence/window-close/restart/shutdown and extension-response routes remain beside their owning maps and timers; chat/queue and Session control/warm/activate/new remain beside their admission and Runtime ownership; model/settings and resource routes remain in maintain mode. A future extraction requires a concrete ownership reduction, not line movement.

Do **not** extract Skills/Extensions resource managers as part of this refactor wave unless a concrete bug requires it. Leave resource pages in maintain mode.

## Reliability convergence freeze

The current refactor wave ends at this architecture. File size, route count, test-file length, or superficial similarity between revisions and generations are not by themselves reasons for another coordination refactor. The ownership and timing documents are guardrails for maintenance, not a backlog for further abstraction.

A later change to core coordination structure must be driven by at least one of:

- a reproducible correctness failure such as cross-Session painting, duplicate writes, wrong Runtime reclaim, shutdown during admitted work, or a lost terminal event;
- a security boundary failure;
- a measured user-visible latency or reliability problem;
- deletion of an existing writable authority or duplicate policy, with one explicit remaining owner;
- a focused regression that fails before the change and passes after it.

Every admitted coordination change must state which existing authority or policy it removes, which module becomes the sole owner, and which concrete behavior is corrected. Adding a facade, revision, generation, cache layer, hook, reducer, route adapter, or test framework without removing existing authority is out of scope. Broad test cleanup and source-shape deletion remain deferred until observed maintenance cost justifies a separate rollback surface.

## Frontend module map

The step 3 ownership boundary and staged migration are defined in [`frontend-state-ownership.md`](frontend-state-ownership.md). State migration must follow that design gate before component extraction. For day-to-day change intake, use [`change-map.md`](change-map.md) to locate the canonical owner, timing domain, invariant, and focused validation; it is an index and does not override this architecture.

| Module | Responsibility |
|---|---|
| `App.tsx` | UI state and business mapping of events |
| `hooks/use-pi-event-source.ts` | EventSource lifecycle |
| `hooks/use-live-message.ts` | Stream throttle |
| `lib/pi-events.ts` | Event parsing |
| `lib/session-view-cache.ts` | Client-side view LRU |
| `lib/active-sessions.ts` | Writable/active session helpers |
| `lib/state-diagnostics.ts` | Always-on page-local bounded diagnostic lane, per-export Session aliasing, and combined JSON download; no persistence or pane authority |

Prefer small hooks and pure libs over growing `App.tsx` further.

## Runtime and session policy

- **Session view is the navigation authority.** A persisted JSONL Session can be opened and read while no corresponding Pi Runtime exists, while Primary is starting, or after Primary compatibility has failed.
- Primary readiness is explicit (`starting` / `ready` / `failed`), not inferred from a spawned child process. Starting/failed read projections must issue zero Primary RPC requests.
- Compatibility is a process-wide capability of the configured local Pi entrypoint: Primary is the single probe owner. A new or recovered Secondary therefore requires a ready Primary capability, but an already healthy Secondary remains independently usable if Primary later fails; Secondary startup still verifies its own `get_state` response.
- Primary writes and crash recovery pass the readiness controller; every restart re-runs compatibility probing, so a failed probe cannot be bypassed by an implicit restart.
- Cold history view: JSONL is returned first with gray/view-only status. Browsing, scrolling, search, pagination and cache navigation never start a Secondary Runtime.
- Runtime preparation is a Session-scoped single-flight capability upgrade for explicit write/control intent. It never creates a blank Runtime or rebinds a process between Sessions.
- Activation on real work: send, compact, model/thinking, taking control, or explicit activate. A send to an inactive Session awaits its shared readiness promise rather than a full activation view.
- A new draft's first user turn performs Runtime creation, Model, Thinking, conditional Gate synchronization, and prompt admission under one draft lease and one Session prompt-admission FIFO; it avoids browser-side sequential setup requests.
- A late warm/activation response may update only its own pane cache; it must not repaint a newer selected Session. Runtime startup's successful `get_state` response is retained as `lastState`, and cached Session identity/path/cwd avoids a global SessionIndex scan; unknown IDs refresh once then fail closed.
- Gate synchronization is conditional: an authoritative Runtime already in the requested mode receives no redundant `/gate` command.
- Hard cap: at most 5 hot conversations total (Primary + at most 4 Secondary Runtimes)
- Cold JSONL history views do not count toward the hot limit
- At capacity, the least-recently-used reclaimable idle Secondary is rested first
- If every Secondary is busy or protects a live empty draft, the next activation is rejected with HTTP `409`
- Viewed idle runtimes may be reclaimed (not permanent pins)
- Model/Thinking changes do not auto-claim control; foreign owners are rejected

## Session control (0.4)

- Observing banner only when a **live** foreign SSE owner exists
- Sole live window auto-claims; never stuck behind a ghost owner
- Disconnect grace defaults to 1.5s (reconnect safety without long takeover flash)
- Frontend banner debounced (~400ms) to suppress reconnect flaps
- Multi-window exclusive write control remains enforced

## Compatibility

Prefer **RPC capability probe** over a hard Pi version allowlist.

| Field | Value (0.4.1) |
|---|---|
| Required capabilities | `get_state`, `get_messages`, `get_available_models`, `get_commands`, `get_session_stats` |
| Last verified Pi | 0.83.0 |
| Minimum practical | Recent Pi with full RPC surface above |

Missing required capabilities → fail startup clearly.

## Application restart (0.3.1+)

Windows often returns `EPERM` if `dist/` is renamed while the live Node process still has open handles (loaded modules under `dist/server`).

**Policy:**

1. Build into `.pi-chat-dist-staging-*` (never touches live `dist` during build)
2. Quiescence checks still run in-process
3. HTTP 202, then spawn `restart-handoff`
4. Parent shuts down and exits
5. Handoff waits for parent PID exit → **promote** staged → live `dist` (with rename retries, keep previous backup)
6. Start candidate server and wait for `/api/health`
7. On health success, drop the previous tree; on failure, **rollback** previous → live and start the old build

Startup best-effort removes orphaned staging/previous/failed trees (unless a handoff is still protecting a rollback backup).

### Empty New drafts

- Drafts are owned by the creating browser window (`draftOwnerClientId`)
- Idle empty drafts are reused within the same window; other windows never share them
- A draft with real messages (including Extension commands) is committed into the session list before the next New

## Security posture

- Loopback listen only
- Rotating in-memory request token
- Strict Host / Origin checks
- System Gate is installed and self-healed; not a user-removable ordinary extension
- No public network deployment story in 0.4.x
- State diagnostics is always-on, loopback-guarded, memory-only, age/count/byte bounded, and closed-schema redacted. Unknown event pairs and detail keys are dropped, API routes are canonicalized to known static/dynamic templates, and unknown enum-like values become `unknown`, so attacker-, extension-, or model-controlled strings cannot survive under an innocuous key. Any authenticated currently registered Pi Chat page may read the shared process snapshot; export does not start, stop, reset, or own the recorder, and page closure changes no diagnostic lifecycle. The browser combines that process lane with only its own page-local lane and replaces stable Session IDs with per-export aliases. Structural state metadata and selected SSE transport outcomes are retained; request tokens, headers, prompts, transcript/draft content, images, paths, secrets, raw errors, stacks, and client identities are excluded
