# Pi Chat v0.4.7

## Windows-first stability preview

Pi Chat v0.4.7 is a Windows-first, local-first stability release. It is intentionally published as a **半成品 / stability preview**, not as a 1.0 release, not as a finished adoption release, and not as a promise that every platform or Runtime edge case is complete.

The runnable Windows package is:

```text
pi-chat-windows-0.4.7.zip
```

The ZIP, portable SHA-256 file, and manifest are generated from the same tagged source revision. The manifest records the package version, exact revision, build fingerprint, ZIP size, and checksum.

## Included in v0.4.7

- Bootstrap Composer protection: the initial Composer stays read-only until the authoritative Session identity is committed, preventing input from being written into a provisional `session:none` partition.
- Server-owned Prompt identity propagation across HTTP admission, SSE, Browser PromptOperation, optimistic LocalUserTurn, queueing, reconnect, retry metadata, and terminal settlement.
- Duplicate Prompt protection that preserves two genuinely identical Prompts as two separate turns.
- Session-scoped shared-write FIFO coverage for ordinary Prompts submitted from multiple browser windows.
- Runtime generation, Session replacement, deletion, navigation, A → B → A, SSE reconnect, and retry terminal fencing.
- Isolated Playwright coverage for startup readiness, duplicate Prompts, reconnect, retry success/exhaustion, long Sessions, Session navigation, Files/Changes inspection, and responsive desktop/mobile behavior.
- Windows release hygiene: branch/tag CI separation, pinned GitHub Actions, staged artifact packaging, manifest/checksum verification, and `SECURITY.md` included in the package.
- Files/Changes sidebar splitter pointer capture so Windows Chromium drags continue after the pointer leaves the narrow grip.
- Ask User questionnaire preview stabilization: preview content uses a fixed layout slot and remains inside the same hover region as its options, so moving toward the preview no longer causes the dialog to jump or flicker.

## Current boundaries and unfinished work

This release is deliberately not presented as complete. The following work remains open for later adjustments:

- Real provider failure, 429, timeout, native retry, retry SSE metadata, and Browser projection are not validated against the live Pi Chat listener. A dedicated isolated mock-provider or temporary Pi Chat instance is still required.
- Live Pi Chat restart, deployment, live Prompt smoke, live queued Prompt smoke, and live provider retry were not performed for this release.
- Windows browser-agent tooling has been improved separately, but the broader Windows launcher, browser profile, proxy, port, and independent-window workflow still needs further field validation.
- More complete identity matrices remain useful for queued Prompts, Secondary Prompts, uncertain delivery, retry-before-HTTP, abort during retry, Session replacement/deletion, and navigation fencing.
- Large Session resource baselines at 128 MiB, 256 MiB, and 512 MiB still need representative peak RSS, latency, index refresh, and concurrent-access measurements.
- Pi Chat remains loopback-only and local-first. It is not a remote multi-user service and does not provide a remote access switch.
- Pi remains the only agent loop, Runtime, Session/JSONL, model, tool, Skill, Extension, retry, Steer, and transcript authority. Pi Chat does not add a second Runtime or transcript system.
- No open-source license has been selected for this repository. This release does not grant MIT, Apache-2.0, or another open-source redistribution license.

## Verification

The release candidate was checked in isolated staging paths rather than the live repository `dist/`:

```text
npm run typecheck
npm run verify:unit
npm run verify:e2e
npm run verify:artifact
npm run check:committed-text
```

The Windows CI tag workflow must complete successfully before this release is considered verified. The `.sha256` sidecar is the canonical checksum record for the attached ZIP; the `.manifest.json` sidecar is the canonical identity record.

## Installation scope

1. Install Node.js 22.19+.
2. Install and authenticate Pi 0.85.1 or a compatible Pi with the required RPC surface.
3. Download and extract the Windows ZIP.
4. Run `start-pi-chat.cmd` or `start-pi-chat-ui.ps1`.
5. Open the loopback listener shown by the launcher, normally `http://127.0.0.1:30170`.

For known limitations and security boundaries, see [`README.md`](README.md) and [`SECURITY.md`](SECURITY.md).
