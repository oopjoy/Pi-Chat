# Pi Chat v0.5.3

## First self-contained Windows Setup, plus a portable archive

v0.5.3 is the first stable release of the complete Windows installer. v0.5.2 on GitHub was still the ~192 KB online bootstrapper; this tag ships a real Setup and restores a portable ZIP for machines that already have Node and Pi.

Release assets:

```text
pi-chat-setup.exe
pi-chat-portable-0.5.3.zip
```

GitHub also attaches the two source archives. Checksum and manifest sidecars are generated and verified in CI but are not uploaded.

Pi remains the sole authority for Runtime execution, Sessions, JSONL, Prompt delivery, retry, Steer, tools, models, and transcript state. The Web core remains the only product surface.

## Windows Setup

`pi-chat-setup.exe` is a single-file Inno Setup installer (no Electron):

- Embeds the compiled app and a pinned private Node 22 runtime (with npm). The install itself does not need Git, a system Node, or a network connection.
- Defaults to `%LOCALAPPDATA%\PiChat`; the destination can be changed. Primary shortcuts open Web in the system default browser. A tracked `Pi Chat Web.lnk` lives in the install root; `Pi Chat PWA` remains an optional Start-menu entry.
- Reuses an existing local Pi. Missing Pi is an explicit optional online step; skipping it or a download failure still leaves the app installed so a later connection can recover.
- Registers uninstall (Settings → Apps → Pi Chat). Uninstall removes the app, private Node, and this install's own config; it does not delete `~/.pi/agent` sessions, credentials, or Skills.
- Refuses upgrade or uninstall of a running destination instead of failing mid-copy. Source-checkout shortcuts stay in a separate `Pi Chat Git` group and are never claimed by Setup.

## Portable ZIP

`pi-chat-portable-0.5.3.zip` is the app payload only (Web, compiled server, runtime adapters, Windows launcher scripts, and docs). It does **not** include Node or Pi.

- Windows: extract and run `start-pi-chat-ui.ps1` or `pi-chat-launch.cmd`.
- Linux/macOS: with Node 22.19+ and Pi already installed, run `node dist/server/server/index.js`.

The ZIP uses forward-slash entry names so it extracts cleanly outside Windows. File picker, Explorer reveal, and Setup-managed Pi stay Windows-only. Pi Chat remains Windows-first; the portable archive does not make non-Windows a supported product channel.

## Assistant Markdown: local files and images

Saved assistant replies may link to, and render, explicit local paths:

- Workspace-relative and, when the destination is written into the persisted reply, paths outside the Session workspace.
- Links open through the Session-addressed opener; allowlisted image types render inline through an authenticated endpoint (`<img>` cannot send the app token, so the UI fetches a blob URL).
- Authority is exact destinations in the saved Markdown only: a link never grants render rights, and an image never grants open rights. Traversal, ADS, UNC/network paths, symlinks, sensitive names, and executable types stay blocked. The Files inspector remains workspace-contained.

## Process activity and visual language

- Tools map to semantic families (terminal, message, mutation, document, search, agent, network, image) with one stable icon per family and a wrench fallback. Thinking rows use an amber bulb; completed checks are status-green, errors are danger-red, and the running spinner keeps accent. Presentation never feeds Gate, approval, or security.
- Second token-convergence pass across settings, management, about, welcome, queue/steer, attachment, and subagent surfaces. Composer, Sessions, and Conversation remain the product IA.

## Reliability

- Runtime capacity rejection now states occupancy (n/N hot conversations, how many are busy) and that Session history stays readable.
- Large-history outlines keep naming-entry IDs and parent links; older pages stay bounded; idle hot views no longer attempt an oversized full snapshot first.
- Image prompts reconcile against Pi's post-preflight user message so the pending bubble retires only after a matching persisted JSONL row.
- Windows path separators and command backslashes survive in tool summaries; long paths keep the filename.

## License

This repository is MIT-licensed (`LICENSE`, copyright 2026, oopjoy and Pi Chat contributors). Releases through v0.5.2 carried no open-source license.

## Verification

Windows Release CI on tag `v0.5.3` built and verified the Setup (including isolated install/upgrade/uninstall) and the portable ZIP from this tagged revision. Main-branch CI also publishes a commit-addressed Setup artifact for testing; those artifacts do not create or move tags.

## Known boundaries

- Windows-first. Portable ZIP on Linux/macOS is a deployment convenience, not a support commitment.
- Process-area grouping of consecutive same-family tools (Phase 3) and weakening historical green ticks (Phase 2) are deferred until long runs are observed on this build.
- The 65-second cold Session start is not closed; isolated import/factory measurements are much smaller and do not prove the incident is gone. See `docs/runtime-startup-investigation-2026-10-14.md`.
