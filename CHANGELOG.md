# Changelog

## 0.4.5

### Streaming and long-session performance

- Cumulative assistant output now uses authoritative checkpoints and append-only deltas, stable projected message identities, progressive Markdown/GFM/KaTeX rendering, sequence-gap recovery, and a canonical terminal render without changing the production $50$ ms latest-wins cadence.
- Large Session JSONL files now retain committed byte offsets and parse only verified append-only suffixes, with rewrite fallback and active-branch semantics. Session inventory scans also retain bounded negative results and avoid repeated cold-start work.
- Provider terminal reconciliation prevents duplicate live/persisted replies without globally deduplicating independent assistant turns.

### Session management and reliability

- Cold or reclaimed Sessions can compact through their own restored RPC binding, and compaction completion clears stale tool state while returning to the normal blue running presentation.
- Clone and Fork create independent cold Sessions through the source Session's single RPC writer. Both require confirmation; Fork previews its exact history boundary and restores the selected User message as an editable, unsent draft.
- Fork provenance is stored atomically in a Pi Chat sidecar rather than either Pi JSONL. Forked conversations show a cold navigation link to their source, fail closed when the source is deleted, and retain duplicate-operation guards when a committed outcome needs recovery or index confirmation.

### Workspace and Composer interface

- The right-side Workspace Inspector now provides `Files` and `Changes`: Files lists the current Session's most recent successful Edit/Write targets with bounded fail-closed previews, while Changes retains the unified Edit projection.
- The file list/preview split is keyboard and pointer resizable, and code previews support readable typography plus horizontal scrolling.
- The Composer model selector is smaller and name-first while retaining model IDs on hover.

### Verification and package scope

- TypeScript checks, the isolated $964$-test unit suite ($960$ passed, $4$ platform-skipped), and all $19$ Playwright scenarios pass.
- `pi-chat-windows-0.4.5.zip` is the runnable Windows package. GitHub-generated source archives are source-only development inputs.
- Pi Chat remains loopback-only and local-first; this release does not add remote hosting, a desktop shell, or a replacement Pi agent loop.

## 0.4.4

### Conversation reliability

- Prevented a final live assistant snapshot from rendering a second copy when its complete reply has already reached the persisted active turn, including provider frames that omit or rewrite the terminal timestamp. The reconciliation is limited to that explicit live-versus-persisted handoff; separate persisted assistant turns are never collapsed merely because their text matches.
- Sanitized the distinct provider failure mode where one assistant text payload contains two byte-for-byte copies of a substantial complete response, without rewriting Session JSONL.
- Local intercom coordination messages now fold after $10$ source lines and provide accessible expand/collapse controls.

### Composer and native Steer presentation

- Model and Thinking controls retain the last confirmed model catalogue during transient empty Runtime metadata refreshes instead of becoming temporarily unavailable.
- Accepted native Steer messages now appear immediately in a separate waiting section, remain out of the ordinary prompt queue and transcript until Pi confirms consumption, and clear through the existing authoritative consumption or lifecycle paths.

### Package scope

- `pi-chat-windows-0.4.4.zip` is the runnable Windows package. GitHub-generated source archives are source-only development inputs.
- Pi Chat remains loopback-only and local-first; this release does not add remote hosting, a desktop shell, or a replacement Pi agent loop.

## 0.4.3

### Runtime, RPC, and settlement recovery

- Primary startup now uses one 60-second `get_state` readiness request, reuses that state for compatibility validation, and recovers failed children through single-flight mutation boundaries without deleting Session history or changing user configuration.
- Post-settlement Primary and Secondary FIFO barriers use independent 60-second reads, so an ordinary coalesced query cannot lend them a shorter timeout or allow stale RPC frames into the next turn.
- Abort timeouts distinguish "accepted and still settling" from failure; queue, Steer, and terminal bookkeeping remain generation-scoped while slow Pi/tool shutdown completes.
- RPC stream listeners and JSONL parsing are isolated from handler exceptions, process-level rejection/exception diagnostics are retained, and crashed Runtime recovery releases stale dispatch locks instead of permanently stranding queued prompts.

### Reload, multi-session, and authority hardening

- Bootstrap, SSE readiness, handshake leases, replacement processes, navigation, Session views, prompt acknowledgements, failures, and cache refreshes are guarded by process/run/navigation authority so stale A-to-B-to-A continuations cannot repaint or lock a newer pane.
- F5 and replacement handshakes use temporary page leases that expire unless promoted by SSE, avoiding both premature last-window shutdown and leaked page ownership.
- A default New view stays local until its first prompt, preserves its captured workspace, and does not create an empty JSONL or eager Secondary Runtime.
- Prompt/Steer admission, recovery, queue ordering, compaction settlement, and first-token timing have expanded deterministic regression coverage.

### Streaming and Composer behavior

- Healthy SSE connections coalesce cumulative assistant snapshots per client and Session at the browser render cadence before JSON serialization; terminal/tool/lifecycle frames flush the newest snapshot first, reducing bursty catch-up when several conversations stream in parallel.
- Primary-relevant Composer editing is disabled until Runtime readiness, while healthy Secondary panes remain independent. Ready drafts accept image attachments immediately and validate pending/unsupported model image capability only at submission without losing text or previews.
- Confirmed slash-command inventories survive transient empty Runtime refreshes, and capability snapshots are scoped to the exact Primary generation and model shape.

### Conversation and workspace interface

- Per-reply model and thinking strength render once above the full thinking/tool process. The active turn receives stable metadata from its first frame, removes the redundant `Pi 正在工作…` placeholder, and reveals its generated time only after streaming fully settles; the copy action remains at bottom-right.
- New-draft workspace paths have an accessible hover/focus dropdown populated from the complete Session directory inventory, ordered by recent use and deduplicated case-insensitively. Quick selection remains local until the first prompt, while the native folder browser remains available for new directories.
- Provider hover text follows each model row, sidebar/runtime status retains concise failure reasons, and completed compaction/tool state no longer leaves stale spinners or paused follow-up prompts.

### Verification and package scope

- Local validation passes TypeScript checks, diff checks, and 526 source tests.
- `pi-chat-windows-0.4.3.zip` is the runnable Windows package. GitHub-generated source archives remain development inputs and require dependency installation plus a source build.
- Pi Chat remains loopback-only and local-first; this release does not add remote hosting, a desktop shell, or a replacement Pi agent loop.

## 0.4.2

### Startup and recovery reliability

- Primary startup now gives its initial `get_state` RPC a single 30-second readiness budget, avoiding the former 2-second timeout/retry path that could leave an uncancellable read outstanding and report a misleading in-progress error.
- A failed initial Primary readiness probe now recovers through the existing single-flight controller when a real Primary mutation or first New draft needs it; read-only JSONL history remains available without warming or mutating a Runtime.
- Primary compatibility validation reuses the successful startup state instead of immediately issuing a duplicate `get_state` request, while preserving the legacy fallback for compatible embedded test doubles.

### Workspace, Gate, and verification follow-ups

- Default-workspace updates now serialize in-process persistence, retry transient Windows replacement failures, and converge across windows/processes without rebinding a live Runtime cwd or changing an existing draft's captured workspace.
- Cold-history Gate choices remain Session-scoped next-prompt intent only; Runtime-confirmed Gate state is kept separate so a staged cold preference cannot auto-authorize a prompt before synchronization.
- Added regression coverage for slow startup readiness, duplicate-read protection, Primary failed-state recovery, Gate confirmation boundaries, and concurrent workspace-state replacement retry.

### Windows CI reliability

- Windows CI tests now resolve compiled inputs through `PI_CHAT_DIST_DIR`, matching the workflow's isolated build rather than assuming a live `dist/` directory exists.
- Shortcut WorkingDirectory verification canonicalizes equivalent Windows 8.3 short-path and long-path spellings.
- Startup smoke now waits independently for the asynchronous Primary RPC capability probe to complete after HTTP handshake readiness, eliminating a nondeterministic missing probe-log race on GitHub-hosted runners.
- The workflow uses `checkout@v5`, `setup-node@v5`, and `upload-artifact@v6`; project commands continue to run on Node 22.

### Package scope

- This is a Windows local-first package release. The GitHub source archive is for development; `pi-chat-windows-0.4.2.zip` is the runnable package and still requires a supported Node runtime plus a globally installed, authenticated Pi.

## 0.4.1

### Reliability convergence

- Cold JSONL history is strictly view-only: browsing, search, scrolling, pagination, and composer focus do not create a Secondary Runtime; real write or control intent activates the Session through a single-flight readiness path.
- New drafts have their own selected working directory, while live Primary and Secondary Runtime cwd bindings remain immutable. Fresh Windows installations default future drafts to the current user's Desktop; existing saved workspace choices are retained.
- The first New prompt now submits Runtime creation, Model, Thinking, Gate synchronization, and prompt admission as one transaction. A bounded JSONL-visibility retry replaces the provisional `新对话` title with the persisted first-turn title after a very fast completion.
- Multi-window lifecycle now distinguishes page presence from reconnectable SSE transport. The last explicitly closed browser/PWA page triggers only a quiescent $10$-second auto-shutdown grace; replacement pages and stale close beacons cannot terminate active work.
- Session navigation adds local search, Session pins, directory grouping, collapse/fixed preferences, and an authoritative Runtime activity projection. Manual Secondary release is removed; automatic safe reclaim remains.
- Build identity is embedded in both the Web bundle and server health/bootstrap responses, so restart handoff detects mismatched frontend/server artifacts.

### Safety, maintainability, and verification

- Hardened loopback API admission, exact handshake/host handling, Runtime provenance, prompt reconciliation, capacity reservations, queue/settlement barriers, and cold-history cache freshness.
- Added explicit feature-surface, frontend state-ownership, and timing-contract documentation. The reliability-convergence architecture is frozen: future coordination changes require a reproducible correctness, security, or measured user-facing problem.
- Playwright now gives each test an isolated local server and dynamic port. Focused tests cover pane authority, draft workspace ownership, Runtime event transitions, route admission, persistence races, and session navigation.
- Validation: `npm run typecheck`, `npm test` ($413$ passing tests), and `npm run test:e2e` ($9$ desktop/mobile applicable tests passing; $9$ intentionally project-skipped).

### Known boundaries

- Pi Chat remains a loopback-only local Web/PWA client; it does not provide remote access, public deployment, Electron, a replacement Pi agent loop, or a plugin platform.
- Package version $0.4.1$ is a source release; generated `dist/`, local Session JSONL, test output, and subagent artifacts are intentionally excluded from Git.

## 0.4.0

### Session-first availability

- Open the HTTP listener and persisted Session index before Primary Pi finishes starting, so saved JSONL conversations remain immediately browsable during Runtime startup, recovery, or compatibility failure
- Expose explicit Primary readiness (`starting`, `ready`, or `failed`) with generation tracking; unavailable read paths issue zero Primary RPC requests while Primary-only mutations return a stable `PRIMARY_RUNTIME_UNAVAILABLE` response
- Re-run the full RPC capability probe after every Primary recovery, and require that process-wide compatibility proof before creating or recovering a Secondary Runtime
- Keep already healthy Secondary workers usable if Primary later fails, while each new or recovered Secondary still verifies its own `get_state` response

### Runtime, transport, and navigation resilience

- Treat SSE/EventSource as a reconnectable transport rather than a service-lifecycle lease: disconnects, write failures, and slow-client backpressure now close only the affected connection
- Preserve explicit shutdown through the close API, last-window policy, restart handoff, and process signals, with typed shutdown reasons in service logs
- Add authoritative reconnect reconciliation so terminal assistant messages are refreshed without duplication after a dropped EventSource
- Cache per-Session history, revisions, terminal leases, overlays, and reading positions while rendering only the selected Timeline; stale HTTP, SSE, warm, model, queue, and extension results cannot repaint a newer destination
- Prepare a cold Session Runtime on composer focus or first mutation without blocking reading, switching, or JSONL history access

### Interface and compatibility

- Distinguish dormant history (`历史会话 · 发送时准备 Pi`) from resident Runtime state (`Pi 已驻留`) without conflating Runtime residency with browser-window control ownership
- Keep completed cold and hot conversations visually equivalent through the same Timeline, Markdown, KaTeX, tool, copy, image, and scrolling presentation
- Verified Pi Chat against Pi `0.83.0`, including real RPC command/model/state/statistics loading with no extension errors
- Added focused readiness, recovery, navigation, Runtime admission, sole-client reconnect, slow-client backpressure, Sidebar semantics, and Playwright coverage

## 0.3.6

### Reliable local-first sessions

- Reworked Secondary Runtime admission, reclaim, and draft handoff so an empty draft cannot be reclaimed while its browser handoff or async emptiness probe is in flight
- Queued Secondary prompts now perform the same acceptance bookkeeping as direct prompts: sidebar admission, branch-recency tracking, and snapshot warming occur after Pi accepts the prompt
- Session view reconciliation now has an explicit SSE invalidation classifier, preventing old snapshots from overwriting newer queue, confirmation, Gate, control, process-status, stream, or transcript state
- Protected optimistic user turns render exactly once when a background Session refresh races prompt acknowledgement
- Terminal SSE assistant messages retain repaired cumulative content, and cache/reclaim/SSE heartbeat accounting has additional concurrency coverage

### Composer, history, and Gate UX

- Rebuilt the compact composer controls and responsive conversation shell; Model, Thinking, Gate, usage, queue, attachment, and stop controls stay session-scoped during streaming
- Assistant footers show the persisted per-reply thinking strength alongside model metadata when available
- Historical session snapshots restore persisted Model and Thinking settings without activating cold Runtimes
- Gate now has only **严格** and **放行** modes. Strict always confirms `write` / `edit` and performs best-effort confirmation for recognized high-risk Bash commands; it does not claim to sandbox arbitrary shell side effects
- Improved process disclosure, read-only edit diffs, queue/local-turn reconciliation, PWA EventSource recovery, navigation epoch isolation, and Windows launcher readiness

### Validation and packaging

- Added focused race, lifecycle, session-cache, SSE, Gate, UI, launcher, and Playwright coverage for the reliability changes
- Added Playwright E2E test scripts and ignores for generated reports

## 0.3.5

### Diff review and session safety

- Added a docked, resizable Diff sidebar that opens from completed `edit` rows without using floating windows or additional protocol data
- Kept Diff details bounded and isolated in the main chat layout, with matching top-bar controls and navigation positioning
- Preserved edit rows during streaming so in-progress, completed, and failed edits do not remount between different element types
- Prevented a failed prompt from a previous Session from restoring its draft text into the newly selected Session
- Unified process-row typography and removed redundant successful-tool completion labels

## 0.3.4

### Session and runtime reliability

- New drafts appear in the sidebar as soon as their first prompt is accepted, without waiting for a long-running response to settle
- Cold Sessions retain their own Model and Thinking preferences without eagerly starting a Runtime
- Rapid switching, stopping, deleting, compaction recovery, and background reconciliation no longer block the shell on slow Runtime probes
- Session sidebar status keeps running, queued, failed, and pending-confirmation states aligned with authoritative server state

### Gate, Markdown, and resource simplification

- Gate preferences survive Runtime recovery and update synchronously across UI and event handlers
- Streaming Markdown renders completed math incrementally without repeatedly building final source-copy offset maps
- Skills, Extensions, and Packages are now a read-only enabled-resource inventory; changes are made directly in their displayed folders while Model management remains editable
- Concurrent builds no longer delete another live Pi Chat process's staging tree

## 0.3.3

### Follow-up fixes

- SSE backpressure now coalesces and replays the latest cumulative assistant snapshot per Session instead of starving visible streaming until final resynchronization
- Rapid Session switches save scroll state against the conversation currently committed to the DOM, preventing positions from being assigned to the destination Session
- Remembered history windows are normalized to the server-supported 20-turn base and 10-turn increments, with the 10,000-turn maximum enforced

### PWA recovery

- New opens an instant local draft and starts a Secondary Pi Runtime only on the first real send
- Cold-start progress now distinguishes Runtime startup, prompt preparation, and Pi thinking without showing Stop prematurely
- Returning to a long-idle PWA proactively replaces a potentially half-open EventSource and refreshes the authoritative Session view
- Accepted prompts reconcile with persisted Session state when SSE frames are missed, so completed replies appear without a manual page refresh
- A compare-and-clear viewed-Session pin prevents delayed local-draft cleanup from unpinning a newer conversation

### Streaming stability

- Visible SSE heartbeats let the frontend detect stale foreground connections instead of relying only on `EventSource.onerror`
- Cumulative `tool_execution_update.partialResult` snapshots no longer enter browser SSE fanout
- Oversized SSE events are replaced with bounded diagnostics, while socket backpressure drops intermediate frames and requests authoritative resynchronization
- The frontend rejects unused cumulative tool snapshots before JSON parsing and safely reconnects after an unexpected oversized frame

## 0.3.2

### UX

- Gate permission requests now use a compact `Pi Chat Gate` dialog with explicit `Block` / `Allow` actions and no redundant Cancel button
- Gate and ordinary Extension requests share one dialog frame, with only provenance, content controls, and response semantics varying
- Long commands wrap inside the permission details area without producing a dialog-level horizontal scrollbar
- An expanded process card stays open while streaming tool steps complete
- Partial selections inside code blocks copy the selected plain text instead of the entire source block
- Changing model / thinking no longer freezes the whole shell (`settingsBusy` only locks those controls)
- Conversation process/message React keys stay stable while streaming thinking text grows (less remount flicker)

### Runtime safety

- Hot conversations are capped at five total: one Primary plus at most four Secondary Runtimes
- Capacity admission is serialized; the least-recently-used reclaimable idle Secondary is rested before a new activation
- When all Secondary Runtimes are busy or protected, the next activation receives HTTP `409` instead of interrupting live work
- Cold JSONL history views remain outside the hot Runtime limit

### Compatibility

- Gate dialogs recognize the stable `Pi Chat Gate · <tool>` protocol, the previous bundled Gate format, and current `Tool requires permission` requests
- Windows launch documentation now distinguishes shortcut installation from direct launch and reports a missing Pi executable clearly

### Stability (carried on 0.3.1 line, released as 0.3.2)

- Restart handoff health-check + automatic rollback to previous `dist` on candidate failure
- Empty New reuses this window’s idle blank draft; drafts are never shared across windows
- Contiguous tool/thinking steps fold into one process card during streaming
- Selected session survives refresh / reconnect; connection recovery after restart
- Appearance steppers, process disclosure, sidebar open animation, and related polish

## 0.3.1

### Stability (Windows restart)

- **Fix `EPERM` on “应用更新并重启”**: live `dist` is no longer renamed while the running Node process still holds handles under it
- Dist promote now runs in `restart-handoff` **after the parent PID exits**, then the new server starts
- Handoff waits for `/api/health` on the candidate; on failure it **rolls back** to the retained previous `dist` and restarts the old build
- Rename retries on `EPERM` / `EBUSY` / `EACCES` with short backoff
- Startup cleans abandoned `.pi-chat-dist-staging-*` / `.pi-chat-dist-previous-*` / `.pi-chat-dist-failed-*` trees
- Clearer promote error hints when a lock remains

### Stability (sessions & UI)

- Empty **New** reuses this window’s idle blank draft (no second spawn); drafts are never shared across windows
- Extension commands on a draft commit it before the next New
- Contiguous tool/thinking steps (persisted + live) fold into **one** process card during streaming
- Selected session survives refresh / reconnect; connection recovery re-bootstraps after restart
- Prompt admission is serialized per session so concurrent sends cannot bypass the queue
- Malformed JSON / oversized bodies return clean 400/413; missing static assets stay 404

### Safety

- Handoff always targets `dist/server/server/index.js` after promote (compiled entry), not a mid-lifecycle `import.meta.url` under a tree about to move
- Parent exit wait extended slightly; brief settle delay before promote on Windows
- Extension UI responses claim-then-send so transport failure remains retryable

## 0.3.0

### Stability & safety

- Session control: sole live window auto-claims; ghost / grace owners no longer flash “接管控制”
- Observing banner only for live foreign SSE owners; ~400ms frontend debounce
- Control grace reduced to 1.5s (reconnect-safe, less takeover flash)
- Extracted `PromptScheduler` and `SseHub` from `PiChatApp` for safer queue/SSE ownership
- Loopback-only listen remains hard-enforced; no remote escape hatch

### UX

- Composer: fixed 14px input size and slightly open letter-spacing (independent of reading size)
- Startup failure splash: Chinese copy, log summary, styled Open log / Retry / Close
- Success splash still hides before opening the Chat window
- Sidebar: remove green running title color; status dots remain the only runtime signal
- Long sessions: auto-load earlier turns when scrolling near the top (button kept)

### Compatibility

- Documented / verified against Pi **0.81.1** via RPC capability probe
- Package version set to **0.3.0**

### Docs

- Product boundaries and module map updated in `docs/architecture.md`
- README Pi version matrix and remote non-goal clarified for 0.3.x
