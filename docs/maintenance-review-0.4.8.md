# 0.4.8 branch maintenance review

This is a source-branch checkpoint, not a new release or a replacement for the published `v0.4.8` artifact. Package versions remain `0.4.8`; the existing tag is immutable.

## Reviewed changes

- Preserve implicit and explicit Thinking intent across non-reasoning selections; rehydrate staged routes from the catalogue and project Runtime-confirmed clamps after model-bearing writes.
- Give every reasoning model the seven semantic Thinking slots; use an exact provider map only to normalize selected slots, searching upward before downward, while missing/empty maps preserve identity mapping.
- Preserve unexposed Provider/model metadata and protect model references in every started Session.
- Reconcile live/persisted assistant signatures without deduplicating ordinary repeated transcript rows.
- Keep consumed Steer labels bounded, process-local and verified by native dequeue plus `message_start`; ignore JSONL-supplied delivery claims.
- Retain process durations, align Sidebar running indicators, expose Clipboard failures, and improve desktop onboarding and accessibility.
- Open persisted assistant Markdown file links through Session-addressed, server-validated Workspace authority. The parser excludes code and images, resolves real reference links, and conservatively rejects text blocks containing raw HTML.
- Bundle only the server Markdown parser dependency boundary so portable artifacts continue to run without `node_modules`.
- Accept both verified Pi RPC follow-up signatures while keeping dequeue adaptation process-local and fail-closed.

## Review corrections

Two new regression groups failed before correction and passed afterward:

1. The previous nearest-distance Thinking clamp differed from Runtime's upward-first clamp. A follow-up regression check confirmed that the UI must retain all seven semantic slots even when a provider map only contains lower-level mappings.
2. The previous link-authority regex admitted indented code and missed reference links/balanced parentheses. It is now based on Markdown syntax rather than text matching.

## Verification

- `npm run typecheck`: passed.
- `npm run verify:unit`: 1,329 passed, 2 platform-dependent skips, no failures across source and benchmark lanes.
- `npm run verify:artifact`: 42 passed, 1 file-symlink privilege skip, no failures. Includes a parser relocation test outside the repository with no adjacent dependencies.
- Isolated build plus `npx playwright test --project=chromium-desktop --project=chromium-forced-colors`: 25 passed.
- `git diff HEAD --check`: passed before commit.

Builds used unique OS-temp staging roots, not the live `dist/`. No production restart or deployment was performed as part of this review. Benchmark tests are correctness checks, not evidence of a new rendering-performance improvement.

## Remaining boundaries

- The user-local `pi-cursor-sdk` 0.3.10 `reasoning_effort` hotfix and custom filters are outside this repository. This commit does not distribute or make that patch durable; SDK updates may overwrite it. Pi Chat still relies on authoritative adapter capability metadata.
- Live inference for the patched Cursor models and the complete deployed browser/Runtime switching flow need a later idle-session deployment window.
- Mobile navigation/layout/E2E remain deferred; this is Windows-first desktop maintenance.
- The published `v0.4.8` release remains unchanged. Any later release must use a new version and tag.
