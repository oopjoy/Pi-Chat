# Changelog

## 0.3.1

### Stability (Windows restart)

- **Fix `EPERM` on “应用更新并重启”**: live `dist` is no longer renamed while the running Node process still holds handles under it
- Dist promote now runs in `restart-handoff` **after the parent PID exits**, then the new server starts
- Rename retries on `EPERM` / `EBUSY` / `EACCES` with short backoff
- Startup cleans abandoned `.pi-chat-dist-staging-*` / `.pi-chat-dist-previous-*` trees
- Clearer promote error hints when a lock remains

### Safety

- Handoff always targets `dist/server/server/index.js` after promote (compiled entry), not a mid-lifecycle `import.meta.url` under a tree about to move
- Parent exit wait extended slightly; brief settle delay before promote on Windows

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
