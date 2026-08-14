# Maintenance navigation measurement

This note records the required pause after test reorganization and the post-adjustment remeasurement. It measures whether the change map, recursive focused runner, isolated browser fixtures, domain test files, and contributor verification entry points are sufficient before considering any production extraction.

## Method

Measured on the isolated `maintenance/test-navigation` worktree after the Web and server test splits. No live `dist` or service was used.

For five representative maintenance tasks:

1. start from the behavior name and the change-map domain;
2. locate the exact concrete regression with repository search;
3. run only its domain file plus `--test-name-pattern` through `scripts/run-tests.mjs`;
4. use the change-map production entries to search the bounded owner/helper set and record the first matching owner locations;
5. record process elapsed time and the files inspected.

Elapsed times are wall-clock measurements from Node `spawnSync`. They include Node/tsx/JSDOM startup where applicable and are descriptive rather than performance gates. The commands use `rg -n -m 1 <behavior> tests` for regression discovery and bounded `rg -n -m 3 <owner terms> <mapped production files...>` searches for production navigation.

## Results

| Task | Domain regression | Locate | Focused validation | Result |
|---|---|---:|---:|---|
| Cold slash catalog fallback | `tests/web/composer-capabilities.test.ts:60` | 23.8 ms | 1.61 s | 1 passed |
| Timed-out native Steer settlement | `tests/server/prompt-queue-steering.test.ts:763` | 22.7 ms | 0.42 s | 1 passed |
| Immutable live Runtime workspace binding | `tests/server/workspace-resource-lifecycle.test.ts:195` | 23.9 ms | 0.39 s | 1 passed |
| Stale pane takeover fencing | `tests/web/pane-authority.test.ts:1116` | 24.9 ms | 2.54 s | 1 passed |
| Window close during admitted mutation | `tests/server/window-control-lifecycle.test.ts:196` | 22.8 ms | 0.42 s | 1 passed |

Production-owner navigation used at most three mapped files per task:

| Task | Mapped files inspected | First owner evidence | Locate |
|---|---:|---|---:|
| Cold slash catalog fallback | 3 | `src/web/App.tsx:405` (`confirmedCommands`) | 21.5 ms |
| Timed-out native Steer settlement | 3 | `src/server/app.ts:1429` (`hasNativeSteeringPending`) | 17.1 ms |
| Immutable live Runtime workspace binding | 3 | `src/server/app.ts:299` (`workspaceRevision`) | 21.2 ms |
| Stale pane takeover fencing | 3 | `src/web/App.tsx:171` (`runEpochGeneration`) | 16.9 ms |
| Window close during admitted mutation | 3 | `src/server/session-control.ts:1` and `src/server/app.ts:310` | 15.6 ms |

The tables are the durable result. Machine-readable raw captures from this run were also written outside the repository to `C:/Users/opjoy/AppData/Local/Temp/pi-chat-maintenance-navigation-measurements.json` and `C:/Users/opjoy/AppData/Local/Temp/pi-chat-maintenance-production-navigation.json`; they are optional audit artifacts, not required to interpret or reproduce the documented commands.

## Post-adjustment remeasurement

Remeasured on local `main` after Session Inventory, artifact safety, line-ending policy, and contributor verification landed. The live service and live `dist` were not used. The same five tasks were repeated, and a sixth Session Inventory refresh task was added because it is the largest newly integrated maintenance surface. Focused tests still ran through the official harness; the new `test:focus` npm alias is an argument-preserving entry to that harness.

| Task | Current regression | Locate | Focused validation | Owner locate | Result |
|---|---|---:|---:|---:|---|
| Cold slash catalog fallback | `tests/web/composer-capabilities.test.ts:60` | 18.5 ms | 1.37 s | 13.2 ms | 1 passed |
| Timed-out native Steer settlement | `tests/server/prompt-queue-steering.test.ts:660` | 15.0 ms | 0.53 s | 12.0 ms | 1 passed |
| Immutable live Runtime workspace binding | `tests/server/workspace-resource-lifecycle.test.ts:92` | 15.6 ms | 0.49 s | 11.9 ms | 1 passed |
| Stale pane takeover fencing | `tests/web/pane-authority.test.ts:1116` | 15.7 ms | 2.29 s | 18.9 ms | 1 passed |
| Window close during admitted mutation | `tests/server/window-control-lifecycle.test.ts:93` | 17.3 ms | 0.51 s | 17.6 ms | 1 passed |
| Fresh full Session Inventory refresh | `tests/web/session-inventory-mutations.test.ts:1582` | 18.4 ms | 1.36 s | 16.4 ms | 1 passed |

Each owner search remained bounded to three mapped files. The Session Inventory sample reached `reconcilePendingSessionMutations` and its fresh `api.sessions(true, [], true)` call in `src/web/App.tsx` without requiring a repository-wide coordinator read. The complete contributor gate also passed with 624 unit tests (623 passed and one Windows symlink-permission skip) plus 16 Playwright cases; its successful unit and E2E staging directories were removed automatically.

The machine-readable remeasurement is stored outside the repository at `C:/Users/opjoy/AppData/Local/Temp/pi-chat-maintenance-navigation-remeasurement.json`.

## Structural comparison

| Before | After |
|---|---|
| `tests/app-lazy-new.test.ts`: 11,595 lines | 9 Web domain files; largest 2,175 lines |
| `tests/dual-session.test.ts`: 3,533 lines | 9 server domain files; largest 1,178 lines |
| shell-dependent top-level test glob | recursive deterministic Node discovery |
| no official file selector | repeatable repository-contained `--file` selector |
| repeated ad hoc App DOM/API/EventSource setup | single-purpose helpers and fresh fixture factories |

All 192 concrete test names from the two former large files remain present: 119 Web names and 73 server names. The Web source has 118 top-level declarations because one template loop expands to two concrete names (`ready` and `failed`); declaration count is therefore not the preservation metric. At the initial checkpoint, the full suite was 590 tests with one Windows symlink-permission skip. The post-adjustment gate above is the current count.

## Decision

Stop before production extraction.

Across the initial and post-adjustment samples, the measured tasks reach one behavior-focused test file immediately, validate one exact regression in roughly 0.4–2.6 seconds, and narrow production-owner inspection to no more than three mapped files with an owner match in roughly 12–22 ms. The remaining large production coordinators (`src/web/App.tsx` and `src/server/app.ts`) are still integration owners, but these samples do not require broad repository exploration before reaching their relevant owner region. A speculative pure-logic move would add code movement and review surface without evidence of duplicated policy or an independently testable owner boundary.

Production extraction should be reconsidered only when a concrete change requires broad coordinator reading after the domain regression is known, or when repeated maintenance samples identify one pure projection/transition that can move without acquiring lifecycle, timer, transport, Runtime, or pane authority. Any such future extraction must follow the ownership and freeze rules in `architecture.md`, not a line-count target.

The post-adjustment sample does not change this decision. Session Inventory added substantial behavior but still reaches its regression and owner boundary through one domain test and three mapped files. No duplicated writable authority or independently owned pure transition emerged, so splitting `src/web/App.tsx` or `src/server/app.ts` now would remain speculative code movement.
