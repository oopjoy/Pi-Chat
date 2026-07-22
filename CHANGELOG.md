# Changelog

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
