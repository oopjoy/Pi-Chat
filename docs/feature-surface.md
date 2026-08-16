# Pi Chat Feature Surface

This inventory is the scope authority for the current 0.4.x convergence work. Every capability must have exactly one status:

- **Product entry**: visible or directly invoked by the browser/PWA product.
- **Retained local API**: intentionally available only on the loopback service for launchers, local automation, lifecycle handoff, or a future local CLI. It is not a hidden browser feature.
- **Removed**: no product entry, browser wrapper, server route, shared type, compatibility branch, or feature-specific regression test may remain.

Internal implementation endpoints used by a product entry are listed with that product capability rather than treated as separate features.

## Product entries

| Capability | Product entry | Supporting local API / contract | Scope note |
|---|---|---|---|
| Bootstrap and reconnect | Browser/PWA startup and application handoff | `GET /api/bootstrap/handshake`, `GET /api/bootstrap`, `GET /api/health`, `GET /api/events` | Handshake is the only tokenless bootstrap API; bootstrap and SSE remain guarded. |
| Chat and streaming | Main composer, send button, Stop, Follow-up queue | `POST /api/chat/prompt`, `POST /api/chat/abort`, `DELETE /api/chat/queue/:id`, `POST /api/chat/queue/resume` | Queue cancellation and resume are visible composer operations. |
| Attachments | Composer attachment menu, paste, drag and drop | `POST /api/local-files/pick`, `POST /api/local-files/clipboard` | Local paths and image payloads only; no upload service. Image prompts allow up to 10 images, 8 MB each and 40 MB decoded total. |
| Session navigation | Sidebar, search, directory groups, history pagination | `GET /api/sessions`, `GET /api/sessions/:id/view`, viewing markers | Cold JSONL navigation does not start a Runtime. |
| Background Subagent visibility | Compact current-Session TopBar count and DSH-inspired navigable child rows | `GET /api/sessions/:id/background-subagents`; `GET /api/sessions/:parent/background-subagents/:child/view` | Exact verified parent-child JSONL address only; child Sessions never enter Sidebar and open in the ordinary Conversation pane strictly read-only. No warm/control/presence or spawn/steer/resume/interrupt/stop capability; main Queue/Steer semantics are unchanged. |
| Default and per-draft workspace | Settings default-workspace picker; New button and new-draft workspace picker | `POST /api/workspace/pick`, `POST /api/sessions/new`, `POST /api/workspace/draft-pick` | The default applies only to later drafts; a per-draft cwd affects only that new conversation. Neither changes a live Runtime cwd. |
| Runtime preparation | Send, Compact, model/thinking change, takeover, explicit internal warm path | `POST /api/sessions/:id/warm`, `POST /api/sessions/:id/activate` | Capability upgrade for real work, not a sidebar resource-management feature. |
| Session control | Observer banner and explicit takeover | `POST /api/sessions/:id/control`, presence and viewing leases | One live browser window writes; other windows observe. |
| Session rename and delete | Session action menu and confirmation dialog | `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id` | Delete may stop an idle dedicated Runtime before removing JSONL. |
| Compact | Composer command/control | `POST /api/chat/compact` | Session-scoped Runtime mutation. |
| Model and Thinking | Composer controls and Models settings | `GET /api/models`, model item routes, `POST /api/models/set`, `POST /api/thinking/set` | Changes are Session-scoped for live work; custom models remain local file management. |
| Gate and Extension UI | Gate mode control, generic select/confirm/input/editor dialogs, and a rich `ask_user_question` multi-question projection with previous/next navigation, inline custom input, hover/selected states, and final-submit gating | `POST /api/extension-ui/respond` | Gate is a Pi Chat system safety component. The Ask projection validates the admitted tool-call questions and translates the completed browser draft back onto the Package's existing ordered scalar RPC requests; request IDs, Session/control authority, cancellation, and first-response ownership remain unchanged. Other model-facing Pi extensions continue to use the generic Session-scoped dialog path. |
| Skills, Extensions, Packages | Settings management panel | `/api/resources/skills`, `/api/resources/extensions`, `/api/resources/packages`, `/api/resources/browse` | Maintain current management depth; do not expand into a package platform. |
| Appearance and navigation preferences | Settings, sidebar pins/groups/width, conversation navigation | Browser-local storage | No server API ownership. |
| State diagnostic flight recorder | Settings → 诊断 → export recent diagnostics | Authenticated `GET /api/diagnostics/snapshot` plus an always-on browser-local bounded lane | Server and current page retain only the latest five minutes of closed-schema structural facts in memory. Queued Prompt correlation reuses its existing public Queue ID; immediate Prompt UUIDs stay memory-only. Cumulative assistant frames remain aggregate-only: the export includes bounded server/browser scheduling, no-client, oversized-substitute, and write-error counters plus one double-rAF visible-paint opportunity where applicable, without claiming physical display or first-token timing. Export combines the two independently ordered lanes, aliases Session and Prompt correlations per file, and excludes tokens, client identities, message/draft content, images, paths, secrets, and raw errors. Export has no start/stop, window ownership, Runtime, Session, or Pane authority. |
| Restart and shutdown | Sidebar restart, Settings shutdown, window close lifecycle | `POST /api/restart`, `POST /api/shutdown`, `POST /api/window/close`, `POST /api/presence` | Transport loss and final-window close never stop the service; only explicit restart/shutdown owns process lifecycle. |
| Windows/PWA launch experience | Desktop shortcuts, Web/PWA entry, launch status | Launcher scripts plus loopback health/bootstrap | No Electron or bundled browser runtime. |

## Retained local APIs

| Capability | Local API | Why retained | Browser rule |
|---|---|---|---|
| Future-draft default workspace setter | `POST /api/workspace/set` | Deterministic path input for local scripts or a future local CLI. | No `api.ts` wrapper and no ordinary browser UI entry. |
| Health probe | `GET /api/health` | Launchers, restart handoff, and local readiness checks. | Product startup may observe it, but it is not a settings feature. |

These APIs remain loopback-only and must not be described as remote-control surfaces. Workspace default changes never restart, rebind, or change the cwd of a live Runtime.

## Removed

| Capability | Status | Required absence |
|---|---|---|
| Manual release of an idle Secondary Runtime | **Removed** | No sidebar/menu entry, `api.releaseSession`, `/api/sessions/:id/release` route, `SessionSummary.releasable`, manual reclaim reason, or feature-specific tests. Automatic idle/capacity reclaim and deletion-time Runtime stop remain internal lifecycle policy. |
| Todo management | **Removed** | No Todo UI, command registration, tool registration, or extension management. Historical JSONL snapshots remain readable as history. |
| Remote access / public deployment mode | **Removed / non-goal** | No host escape switch, remote auth shortcut, or partial public-network support. |
| Electron shell | **Removed / non-goal** | No bundled Chromium runtime or Electron lifecycle layer. |

## Change rule

A future change that adds or restores a capability must update this file in the same change. A removed capability may return only with an explicit product entry and end-to-end behavior test; adding only a server route, type field, or hidden browser wrapper is not sufficient.
