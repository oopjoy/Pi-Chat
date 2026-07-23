# Changelog

## 0.3.3

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
