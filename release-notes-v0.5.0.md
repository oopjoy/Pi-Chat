# Pi Chat v0.5.0

## Reliability and maintainability release

Pi Chat v0.5.0 is the post-0.4.8 reliability release. Pi remains the sole authority for Runtime execution, Sessions, JSONL, Prompt delivery, retry, Steer, tools, models, and transcript state.

The runnable Windows package is:

```text
pi-chat-windows-0.5.0.zip
```

The ZIP, portable SHA-256 record, manifest, and embedded build identity are produced from the same tagged source revision.

## Included

- Web application and server decomposition completed without changing Runtime, Session, FIFO, generation-fencing, lease, or response-before-release authority rules.
- Pi SSE handling split into message/streaming, Runtime lifecycle, workspace/session, queue/extension, and failure/control domains while keeping admission and fencing in the central handler.
- Prompt sending split into preparation, Runtime/Draft warm-up, acknowledgement reconciliation, and failure/uncertain-delivery handling.
- New-draft first-send Prompt identity is bound before retry lifecycle frames can race the browser acknowledgement.
- Prompt acknowledgement, Queue projection, native Steer, stale-pane, and uncertain-delivery paths retain explicit reconciliation boundaries.
- Nested Prompt route host Proxy usage was removed while preserving the active Primary `running` write-through behavior.
- Several residual `any` aliases were replaced with the actual authority and projection types.
- App and server decomposition targets remain within their maintained size ranges without introducing a product rename.

## Verification

The release source passed:

```text
npm run typecheck
npm run test:preflight
npm run test:source
npm run check:committed-text
```

The release package is source-authority aligned with the tagged revision and includes the generated build identity, Windows launcher assets, Pi Runtime resources, and portable checksum sidecar.

## Known boundaries

- Pi Chat remains loopback-only, local-first, and Windows-first.
- The source archive is source-only. Use the Windows ZIP for the runnable packaged application.
- A supported Node.js 22.19 or newer installation and a compatible authenticated Pi installation are required.
- Do not restart a live installation while Sessions, queues, confirmations, or Runtime operations are active.

## Installation

1. Install Node.js 22.19 or newer.
2. Install and authenticate Pi 1.0.0 or a compatible Pi with the required RPC surface.
3. Download `pi-chat-windows-0.5.0.zip` and its `.sha256` sidecar.
4. Verify the checksum, extract the ZIP, and run `start-pi-chat.cmd` or `start-pi-chat-ui.ps1`.
5. Open the loopback listener shown by the launcher, normally `http://127.0.0.1:30170`.
