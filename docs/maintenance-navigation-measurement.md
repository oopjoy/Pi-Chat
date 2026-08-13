# Maintenance navigation measurement

This note records the required pause after test reorganization. It measures whether the new change map, recursive focused runner, isolated browser fixtures, and domain test files are sufficient before considering any production extraction.

## Method

Measured on the isolated `maintenance/test-navigation` worktree after the Web and server test splits. No live `dist` or service was used.

For five representative maintenance tasks:

1. start from the behavior name and the change-map domain;
2. locate the exact concrete regression with repository search;
3. run only its domain file plus `--test-name-pattern` through `scripts/run-tests.mjs`;
4. record the located file/line, process elapsed time, and result.

Elapsed times are wall-clock measurements from Node `spawnSync`. They include Node/tsx/JSDOM startup where applicable and are descriptive rather than performance gates.

## Results

| Task | Domain regression | Locate | Focused validation | Result |
|---|---|---:|---:|---|
| Cold slash catalog fallback | `tests/web/composer-capabilities.test.ts:60` | 23.8 ms | 1.61 s | 1 passed |
| Timed-out native Steer settlement | `tests/server/prompt-queue-steering.test.ts:763` | 22.7 ms | 0.42 s | 1 passed |
| Immutable live Runtime workspace binding | `tests/server/workspace-resource-lifecycle.test.ts:195` | 23.9 ms | 0.39 s | 1 passed |
| Stale pane takeover fencing | `tests/web/pane-authority.test.ts:1116` | 24.9 ms | 2.54 s | 1 passed |
| Window close during admitted mutation | `tests/server/window-control-lifecycle.test.ts:196` | 22.8 ms | 0.42 s | 1 passed |

Raw measurements are stored outside the repository at `C:/Users/opjoy/AppData/Local/Temp/pi-chat-maintenance-navigation-measurements.json`.

## Structural comparison

| Before | After |
|---|---|
| `tests/app-lazy-new.test.ts`: 11,595 lines | 9 Web domain files; largest 2,175 lines |
| `tests/dual-session.test.ts`: 3,533 lines | 9 server domain files; largest 1,178 lines |
| shell-dependent top-level test glob | recursive deterministic Node discovery |
| no official file selector | repeatable repository-contained `--file` selector |
| repeated ad hoc App DOM/API/EventSource setup | single-purpose helpers and fresh fixture factories |

All 192 concrete tests from the two former large files remain present: 119 Web and 73 server. The full suite remains 590 tests with one Windows symlink-permission skip.

## Decision

Stop before production extraction.

The measured tasks now reach one behavior-focused test file immediately and validate one exact regression in roughly 0.4–2.6 seconds. The remaining large production coordinators (`src/web/App.tsx` and `src/server/app.ts`) are still integration owners, but this sample does not show them as the dominant maintenance-navigation bottleneck. A speculative pure-logic move would add code movement and review surface without evidence of duplicated policy or an independently testable owner boundary.

Production extraction should be reconsidered only when a concrete change requires broad coordinator reading after the domain regression is known, or when repeated maintenance samples identify one pure projection/transition that can move without acquiring lifecycle, timer, transport, Runtime, or pane authority. Any such future extraction must follow the ownership and freeze rules in `architecture.md`, not a line-count target.
