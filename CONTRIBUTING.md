# Contributing to Pi Chat

Pi Chat is a local-first Web/PWA client for a local Pi RPC process. Reliability depends on keeping Session, Runtime, browser-process generation, queue, and lifecycle ownership distinct. This page is the short contributor entry point; it links to the canonical policy instead of repeating it.

## Start safely

```bash
npm install --include=dev
npm run typecheck
```

The normal service listens on `127.0.0.1:30170`. If that service is running, never overwrite the repository's live `dist/`. Direct live-dist builds intentionally fail. Contributor verification uses isolated staging and does not require stopping the service.

Before changing behavior, find the canonical owner and focused regression in [`docs/change-map.md`](docs/change-map.md). Product boundaries live in [`docs/architecture.md`](docs/architecture.md), and visible-pane authority lives in [`docs/frontend-state-ownership.md`](docs/frontend-state-ownership.md).

## Run the smallest useful test

```bash
npm run test:focus -- --file tests/web/composer-capabilities.test.ts
npm run test:focus -- --file tests/web/composer-capabilities.test.ts --test-name-pattern="slash suggestions"
```

`--file` is repeatable. The harness discovers `tests/**/*.test.ts`, sets `NODE_ENV=test`, rejects paths outside the repository, and fails before starting Node when a name pattern matches no statically resolved concrete test. It also owns the test-only resource policy: one Node test file at a time, a 45-second Node test timeout, and a 2 GiB V8 old-space limit. On Windows, the official harness starts its Node test process suspended inside a 3 GiB Job Object before it can create descendants; crossing that Job limit terminates the test tree with `PI_CHAT_TEST_MEMORY_LIMIT_EXCEEDED`. These limits never apply to the production Pi Chat server or Pi RPC process. `--test-concurrency` and `--test-timeout` are therefore reserved harness options rather than caller overrides. The only caller-supplied Node test selectors are `--test-name-pattern`, `--test-shard`, `--test-skip-pattern`, and valueless `--test-only`; reporters, coverage, snapshot mutation, and force-exit flags are deliberately not forwarded.

Do not call `node --test` directly. Do not use bare `npm test` while a live service is running unless `PI_CHAT_DIST_DIR` is already an approved isolated path.

## Run full gates

```bash
npm run verify:unit
npm run verify:e2e
npm run verify
```

The wrappers create separate unique directories under the OS temp directory. Successful staging is removed automatically. A failed unit or E2E stage is retained and printed for diagnosis. `npm run verify` runs typecheck, full unit tests, complete Playwright, and `git diff HEAD --check` serially so both staged and unstaged tracked changes are covered.

Release verification is different: follow [`docs/release-checklist.md`](docs/release-checklist.md) and retain the explicitly named staged artifact that will be packaged.

## Keep one writer

Use one writer for a checkout. Parallel Subagents or other sessions may inspect and review, but they must not edit the same worktree. If parallel implementation is truly necessary, use separate Git worktrees and merge serially.

Before removing a worktree:

1. confirm it is not the current worktree;
2. confirm `git status --porcelain` is empty;
3. preserve untracked or detached work first;
4. confirm its HEAD is merged or deliberately retained by a named ref;
5. use `git worktree remove`, not Explorer deletion.

## Keep generated artifacts out of the repository root

```bash
npm run artifacts:scan
```

The scanner is report-only because legacy `.pi-chat-*` directories have no durable lease proving that another process is finished with them. Verify the owning process and diagnostics value before deleting exact paths. Production restart staging remains owned by the restart coordinator and must not be folded into generic cleanup.

Use `dist-local/` only for intentionally retained local release artifacts. It is ignored and is not a source of truth.

## Preserve ownership boundaries

- Cold Session browsing, search, and pagination stay JSONL-only and must not warm a Runtime.
- One Runtime owns one Session writer and immutable cwd for its lifetime.
- Async visible-pane writes pass through the App coordinator's authority checks.
- Prompt and follow-up ordering stays in `PromptScheduler`; Runtime capacity stays in `RuntimePool`; presence/control stays in `SessionControl`; transport buffering stays in `SseHub`.
- Do not split `App.tsx` or `server/app.ts` merely to reduce line count. A coordination extraction must remove an existing writable authority or duplicate policy and must have a concrete regression.

## Before committing

Run the focused regression first, then the gate appropriate to the change class in [`docs/change-map.md`](docs/change-map.md). At minimum:

```bash
npm run typecheck
git diff HEAD --check
```

Frontend authority, cache, navigation, or user-flow changes require full unit tests and complete Playwright. Packaging, launcher, restart, or release changes require their focused tests plus isolated build verification.

Repository source and documentation use LF endings. `.cmd` and `.ps1` launchers use CRLF. Do not mix line-ending normalization with behavioral changes.

Do not push, publish, deploy, restart the live service, or promote a staged build unless that action was explicitly authorized.
