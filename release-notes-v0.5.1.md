# Pi Chat v0.5.1

## Reliability and deployment maintenance release

Pi Chat v0.5.1 integrates the reviewed Runtime, projection, rendering, and deployment maintenance work while preserving Pi as the sole authority for Runtime execution, Sessions, JSONL, Prompt delivery, retry, Steer, tools, models, and transcript state.

The runnable Windows package is:

```text
pi-chat-windows-0.5.1.zip
```

The ZIP, portable SHA-256 record, manifest, and embedded build identity are produced from the same tagged source revision by Windows Release CI.

## Included

- Contained background Runtime maintenance, serialized shared SessionProjection reads, and safe SSE error/close handling.
- Isolated historical browser rendering and added writer/Promise boundary contracts without changing Runtime or Session authority.
- Replaced whole-App Copy, Model, and Thinking recovery proxies with explicit capability ports and compile-time contract tests.
- Preserved pending local turns after confirmed transcript history so queued work cannot split an earlier tool process or final answer.
- Added exact paired LaTeX inline and display delimiter handling in the rendering copy, while source copy continues to return the original Markdown/LaTeX.
- Added guarded Pi package discovery, package identity validation, per-checkout runtime-entry preferences, and explicit connection setup.
- Added lifecycle-safe service-only restart for changing the selected Pi entry; it does not install packages, download software, or store model credentials.
- Kept Direct Pi RPC, process-local dequeue adaptation, startup diagnostics, Gate enforcement, confirmed writer exit, and cold JSONL browsing boundaries intact.
- Workspace Files revalidates transcript-derived paths against the current Workspace and hides stale paths from moved or deleted checkouts.

## Verification

The integrated source was checked in an isolated worktree with:

```text
preflight: passed
source and benchmark unit verification: passed; the timing-sensitive shutdown boundary was also repeated in ten focused runs
Playwright: 33 passed
artifact lane: 42 passed, 1 environment skip
```

The release package is built in a separate staging directory from the tagged source revision. GitHub-generated source archives remain source-only; use the Windows ZIP for the runnable application.

## Known boundaries

- Pi Chat remains loopback-only, local-first, and Windows-first.
- A supported Node.js 22.19 or newer installation and a compatible authenticated Pi installation are required.
- Runtime connection setup validates local package metadata but does not install Pi or manage model credentials.
- Do not restart a live installation while Sessions, queues, confirmations, or Runtime operations are active.

## Installation

1. Install Node.js 22.19 or newer.
2. Install and authenticate a compatible Pi installation.
3. Download `pi-chat-windows-0.5.1.zip` and its `.sha256` sidecar.
4. Verify the checksum, extract the ZIP, and run `start-pi-chat.cmd` or `start-pi-chat-ui.ps1`.
5. Open the loopback listener shown by the launcher, normally `http://127.0.0.1:30170`.
