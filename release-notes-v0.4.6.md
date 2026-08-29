# Pi Chat v0.4.6

## Conversation continuity and presentation

- Restores the centered New-conversation welcome surface with the Pi bear mark, title, description, and an always-visible new-conversation workspace path selector.
- Empty active Primary Sessions use the New presentation without waiting for sidebar inventory, preventing a transient pathless legacy welcome screen during startup and navigation.
- Local optimistic User turns reconcile conservatively with authoritative persisted JSONL rows, preventing duplicate user bubbles while preserving two genuinely identical prompts as separate turns.
- Completed process rows retain their frozen final run duration after settlement, SSE recovery, and Session navigation.
- Scroll restoration is bound to the Pane identity actually committed to the DOM, with a tighter bottom tolerance to avoid restoring the wrong Session position.

## Runtime, SSE, and recovery reliability

- Runtime replacement, RPC shutdown, abort, model/thinking, Extension, resource mutation, reload, and deletion paths retain fail-closed ownership and `RESULT_PENDING` semantics when an outcome cannot be proven.
- Per-Session Runtime isolation, queue ordering, native Steer handling, compaction ordering, SSE recovery, and single-writer protection remain generation-scoped across reconnects and process replacement.
- Session indexes, resource caches, startup diagnostics, and bundle selection remain authority- and fingerprint-gated without writing browser-local projections or metadata into Pi JSONL/provider payloads.

## Verification and package scope

- TypeScript checks, the focused New/draft regression suite, the isolated unit suite, and the Playwright suite pass for the release candidate.
- `pi-chat-windows-0.4.6.zip` is the runnable Windows package. GitHub-generated source archives are source-only development inputs.
- Pi Chat remains loopback-only and local-first; this release does not add remote hosting, a desktop shell, or a replacement Pi agent loop.

## Integrity

The final ZIP SHA-256, build fingerprint, and exact source revision are recorded after the verified staging build.
