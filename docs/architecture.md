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
| Pi Chat Node service | HTTP, SSE, Runtime pool, lifecycle barrier | “关闭 Pi Chat” / process exit |
| Pi RPC Runtime | One session JSONL writer, model stream, tools | Service rest / reclaim / shutdown |

Closing a browser window must not be confused with stopping the Node service. Stopping the service stops hosted RPC workers.

## Hard product boundaries (0.2.x)

### In scope

- Chat UI, streaming, markdown, attachments
- Session list, cold JSONL history view, on-demand Runtime activation
- Primary + at most 3 idle Secondary Runtimes
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

### Reserved local automation surface

`POST /api/workspace/set` remains a **local** path/body API for scripts or a future local CLI. The browser uses `POST /api/workspace/pick` (native folder dialog). Do not document `workspace/set` as a remote client entry.

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
| `rpc-client.ts` | Global Pi process + capability probe |
| `runtime-pool.ts` | Secondary Runtime maps, capacity mutex, ensure/draft/recover/reclaim/sweep/stopAll |

### Extraction order

Extract **state ownership**, not only functions:

1. **RuntimePool** — done (`runtime-pool.ts`); `PiChatApp` still handles secondary event → queue dispatch glue
2. **SessionControl / WindowPresence** — client connect maps, control owner, release timers
3. **PromptScheduler** — queues, dispatch, abort/resume, pending model/thinking
4. **SseHub** — subscribe/broadcast only
5. **HttpRoutes** — last, after domain services have stable interfaces

Acceptance for a real extraction:

- Maps for runtimes / controllers are private to their owner module
- Routes never mutate those maps directly
- RuntimePool never imports `IncomingMessage` / `ServerResponse`
- Domain modules are unit-testable without a full HTTP server

Do **not** extract Skills/Extensions resource managers as part of this refactor wave unless a concrete bug requires it. Leave resource pages in maintain mode.

## Frontend module map

| Module | Responsibility |
|---|---|
| `App.tsx` | UI state and business mapping of events |
| `hooks/use-pi-event-source.ts` | EventSource lifecycle |
| `hooks/use-live-message.ts` | Stream throttle |
| `lib/pi-events.ts` | Event parsing |
| `lib/session-view-cache.ts` | Client-side view LRU |
| `lib/active-sessions.ts` | Writable/active session helpers |

Prefer small hooks and pure libs over growing `App.tsx` further.

## Runtime and session policy

- Cold history view: JSONL only, gray status, no Secondary Runtime
- Activation on real work: send, compact, model/thinking, explicit activate
- Hard cap: Primary + ≤3 idle Secondary Runtimes
- Viewed idle runtimes may be reclaimed (not permanent pins)
- Model/Thinking changes do not auto-claim control; foreign owners are rejected

## Compatibility

Prefer **RPC capability probe** over a hard Pi version allowlist. Document in release notes:

- minimum tested Pi version;
- last verified Pi version;
- required capabilities.

Missing required capabilities → fail startup clearly. Unverified-but-capable Pi may start with a non-blocking notice later if needed.

## Security posture

- Loopback listen only
- Rotating in-memory request token
- Strict Host / Origin checks
- System Gate is installed and self-healed; not a user-removable ordinary extension
- No public network deployment story in 0.2.x
