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

## Composer attachments

Drag, paste, or pick local files and folders into the Composer. They appear as cards and are sent to Pi as paths, so Pi reads them on demand instead of uploading contents.

- Files are staged from their own bytes, so a same-named file selected in another Explorer window can never be substituted. Folders keep their real path, and a folder card opens in Explorer.
- A drag that carries no local file now says so instead of being silently swallowed. Removing a card deletes its staged temp file.
- Send waits for in-flight staging, so a dropped file cannot land on the next empty draft. Abandoned or rejected temp files are cleaned up.
- Images keep a thumbnail and open a full preview with Escape, a focus trap, and focus returned to the thumbnail. Non-image files show their real type (PDF, TEX, LOG, ...).

## Model configuration

Editing `models.json` no longer restarts Pi.

- A save is versioned by the file's content hash, so a Base URL, API key, or maxTokens change is no longer treated as "nothing changed" when the model list looks identical.
- Each idle worker reloads its own catalogue in place through Pi's public registry refresh. A worker with a request in flight is left alone and refreshed once it settles, and only a Pi without that capability falls back to an idle Runtime reload. Editing models is therefore possible while another Session is generating.
- A Session keeps the model object it selected, so the refreshed limits are applied by re-selecting the same provider/id, which also restores that Session's thinking level.
- Saved, refreshed, and "the current request keeps its original route" are reported separately. A drop or failure that still owes work stays pending and retries on a bounded backoff instead of claiming a clean refresh.

## Restart and Quit

Restart and Quit are on the Sidebar and in Settings. Restart is yellow and Quit is red; a disabled button explains on hover why it cannot run. Closing a window does not stop the background service.

## Windows Setup

`pi-chat-setup.exe` is a single-file Inno Setup installer (no Electron):

- Embeds the compiled app, a checksum-pinned **Node.js 24.22.0 LTS** runtime (with npm), and a pinned **Pi 1.3.0** snapshot. The install itself does not need Git, a system Node, or a network connection.
- Launch prefers a system Node 22.19 or newer when present; if Node is missing or older, it uses the bundled 24.22.0 runtime and says so.
- Defaults to `%LOCALAPPDATA%\PiChat`; the destination can be changed. Primary shortcuts open Web in the system default browser. A tracked `Pi Chat Web.lnk` lives in the install root; `Pi Chat PWA` remains an optional Start-menu entry.
- Reuses an existing local Pi and never upgrades it in place. If none is found, Setup copies the bundled 1.3.0 snapshot offline into `~/.pi/agent/install`. Copy failure still leaves the app installed so a later connection can recover.
- Registers uninstall (Settings → Apps → Pi Chat). Uninstall removes the app, private Node, and this install's own config; it does not delete `~/.pi/agent` sessions, credentials, or Skills.
- Refuses upgrade or uninstall of a running destination instead of failing mid-copy. Source-checkout shortcuts stay in a separate `Pi Chat Git` group and are never claimed by Setup. Desktop keeps only `Pi Chat Web`; an upgrade removes a leftover desktop `Pi Chat.lnk` only when it is this install's own PowerShell Web launcher, never a PWA, another checkout, or a hand-made shortcut.
- Native file and folder pickers open above the browser window instead of behind it.

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

This revision keeps the `v0.5.3` tag and replaces its release assets, so no new version tag was created.

## Known boundaries

- Windows-first. Portable ZIP on Linux/macOS is a deployment convenience, not a support commitment.
- Process-area grouping of consecutive same-family tools (Phase 3) and weakening historical green ticks (Phase 2) are deferred until long runs are observed on this build.
- A folder dragged from Explorer depends on Windows reporting its path or on the item still being selected there; otherwise Pi Chat asks for the picker instead of guessing.
- The 65-second cold Session start is not closed; isolated import/factory measurements are much smaller and do not prove the incident is gone. See `docs/runtime-startup-investigation-2026-10-14.md`.
