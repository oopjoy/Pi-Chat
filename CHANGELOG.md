# Changelog

## Unreleased

## v0.5.4 (2026-10-25)

- Release packaging now explicitly stops on a failed final build or artifact test before creating or publishing either asset. v0.5.4 uses a new immutable tag; historical v0.5.3 assets remain untouched.
- Source Checks checkouts include git history so release-identity regressions can run; the parent-commit identity test skips on a true shallow clone instead of failing for missing `HEAD~1`.
- Session JSONL reference tests canonicalize Windows temp paths before hashing, so GitHub runner 8.3 `TMP` names cannot 500 a valid Session.
- New conversations use the model shown in the composer; custom-model discovery imports explicitly selected upstream IDs. Process timing pauses across upstream retries, duplicate process notes and initial history folding are corrected, and the session action menu can copy a deep link or Session source path.
- Upstream model discovery rejects redirects before forwarding credentials or reading a redirect body. Cancelling/reopening the picker, switching Provider or changing connection inputs retires older success/error/finally callbacks. The 404 fallback regression now actually exercises both candidate endpoints.
- Withdraw experimental cross-refresh draft recovery and its hidden storage-management APIs. Unsent content stays page-memory-only; native leave confirmation is best effort. Existing browser backups are untouched, with explicit inspection/cleanup guidance in README. Managed attachments still renew live leases and retain possibly-sent payloads; failed lease claims/releases retry after edits, reconnect or a bounded heartbeat, without a failure loop.
- Main pushes and PRs now run lightweight Source Checks; full Windows verification remains manual and release-tag verification remains complete. Restore the existing type-debt ceiling by typing the newly added callback seams, without raising its allowance.
- Startup compatibility no longer requests the entire Session through `get_messages`; bounded JSONL history remains readable without risking an oversized startup RPC frame. This is not a claim that the historical slow-start incident is resolved.

- Models token-limit fields are plain numeric-keyboard text inputs, without stepper arrows; invalid non-integer text is not silently converted into a different limit. About keeps its three update/release actions and removes the duplicate Pi connection setup button; failed-Runtime recovery remains available from the Runtime notice.
- The development dependency and lockfile now pin Pi 1.3.0, matching the bundled fallback version. Core real-RPC integration tests explicitly use that project-local dependency rather than silently selecting or requiring a user's global Pi.
- Model synchronization distinguishes unfinished work from retry eligibility. A pre-existing unconfirmed mutation blocks every background entry point, not merely the timer; blocked selection reconciliation stays pending until a correlated response permits verification. Runtime generation/identity is rechecked before applying delayed model results.
- Folder drops no longer scan unrelated Explorer windows and infer a source by basename. Directory drags require an event-provided path or an explicit user selection; existing clipboard-paste matching is unchanged. Bare directory drops name the missing folders, and the attachment menu provides an explicit local-folder picker without changing the Session workspace.

- Full Windows CI no longer runs on ordinary branch pushes or PRs. Use Windows CI → Run workflow for explicit validation; pushing a version tag still runs all Release CI gates before publishing Setup and portable assets.
- Consecutive definite send rejections retain every displaced editor draft (text, images and local paths), not just the latest one. A recover-next control swaps drafts without discarding the editor or sending anything; retained drafts count toward the local payload budget and remain browser-memory-only.
- Mixed file/folder drops no longer return after staging the ordinary files. Directory lookup receives only folder names, omitted directories are reported by name along with the successful file count, and a folder failure never deletes a successfully attached file. Drop entry classification no longer assumes `files` and `items` have matching indexes.
- Distribution docs now consistently describe v0.5.3 Stable, manual Main artifacts, two public Release assets, CI-only sidecars and offline bundled-Pi seeding; compatibility notes distinguish development dependency tests from installer and runtime-discovery checks.

- Model sync state is now owned only by real progress. A failed or deferred background model re-selection keeps the state pending and is retried on a bounded backoff (and on the next settled turn) instead of being reported as finished, and `bootstrap` preserves that state rather than recomputing it from a catalogue comparison. Re-selecting a Session's model after a `models.json` save also restores that Session's thinking level, which Pi otherwise recomputes from the user default. Only a Pi without the process-local refresh adapter falls back to a full Runtime reload; a failure in the cheap path no longer escalates to restarting every worker, and a permanent catalogue gap reloads once rather than on every retry. The full-reload branch also records the revision it actually read. Removing a composer file card now deletes its staged temp file, and a drop that carries no local file explains itself instead of being silently swallowed.

- Model config is versioned by a `models.json` content fingerprint instead of the browser-visible catalogue, so a Base URL, API key, or maxTokens edit is never treated as "nothing changed". Because `baseUrl`, `cost`, `maxTokens`, `contextWindow`, `api`, `reasoning`, and `input` are baked into each Model object at composition time, Pi Chat patches a process-local `pi_chat_refresh_models` RPC that calls `modelRuntime.refresh()` and then re-selects the same provider/id on the documented `set_model` path so the current Session picks up the new limits, restoring that Session's thinking level afterwards. Refreshing never restarts workers: each idle worker reloads its own catalogue, a worker with a request in flight is left alone and refreshed once idle, and only a Pi without the adapter falls back to an idle Runtime reload. Sync state is owned solely by the per-worker revision: bootstrap no longer clears it from a matching model list, a save landing mid-refresh leaves the worker stale, the background re-selection runs in the Session's own admission lane so it cannot overwrite a user's newer choice, and a failed re-selection keeps the state pending rather than reporting ready. The models editor stays usable while another Session is generating.
- Dragging files from Explorer into the composer now reads every text drag flavor (an empty uri-list no longer hides text/plain) and accepts `file://C:/` paths. A dragged file is always staged from its own bytes, so a same-named file selected in another Explorer window can never be substituted; directories without an event-provided path require an explicit folder selection instead of a basename-based guess. Send waits for in-flight staging (bound to a composer epoch, not only the Session id) so a dropped file cannot land on the next empty draft. Count and size are checked before upload; abandoned or rejected temp files are deleted. Folder cards show 文件夹 and open in Explorer; pasted folders are classified by lstat instead of looking like generic files.
- Composer send failures restore the original editor draft and file cards, not the path-composed prompt. Adding or removing attachments advances the draft revision so a late queue undo cannot drop them. Attached paths are always sent as a bounded `[Attached files]` block, never skipped because a longer path already appeared in the message. Setup deletes a leftover desktop `Pi Chat.lnk` only when it is this install's PowerShell Web launcher (`{app}\app\start-pi-chat-ui.ps1` plus that working directory), not a PWA, another checkout, or a hand-made shortcut.
- Sidebar session refresh is now Restart Pi Chat; the previous restart control is Close Pi Chat. Settings keeps Close Pi Chat and adds Restart Pi Chat above it. Existing confirmation dialogs are unchanged. Disabled Restart/Quit buttons explain on hover why they cannot run (generating, waiting for confirmation, or queued).
- Composer shows local files as cards (images keep a thumbnail). Sending still gives Pi the absolute path so it can read on demand; clicking a file card opens it with the Windows default application.
- Setup no longer creates a desktop `Pi Chat` shortcut (it duplicated Web and looked like the old PWA). Desktop keeps `Pi Chat Web` only; an upgrade deletes the leftover desktop `Pi Chat.lnk` and never touches `Pi Chat Git`.

## v0.5.3 (2026-10-16)

### Private Node runtime and bundled Pi fallback

- Setup embeds Node.js 24.22.0 LTS (checksum-pinned win-x64) and a pinned `@earendil-works/pi-coding-agent@1.3.0` snapshot. Launch prefers a system Node 22.19+ when present; if Node is missing or older, it uses the bundled runtime (and says so). Pi still prefers an existing local install and is never upgraded in place; only a machine with no Pi gets the bundled 1.3.0 copy, offline, into the managed `~/.pi/agent/install` layout. Source checkouts and the portable ZIP keep Pi's official Node floor of 22.19+.

### Cross-workspace assistant references

- Saved assistant Markdown links and images may reference explicit paths outside the Session workspace: links open through the Session-addressed opener, and allowlisted image types render inline through an authenticated endpoint. Authority comes only from exact destinations in the persisted reply (links never grant render authority and images never grant open authority); traversal, ADS, UNC/network paths, symlinks, sensitive names, and executable types stay blocked, and the Files inspector remains workspace-contained.

### Process activity visual semantics (Phase 1)

- Tools map to semantic families (terminal/message/mutation/document/search/agent/network/image) with one stable icon per family and a wrench fallback, so extension tools join existing visual language without new icons. Thinking rows show an amber bulb; completed checks are status-green, errors danger-red, and the running spinner keeps accent. Presentation mapping is strictly separated from permission semantics.

### Visual-language convergence

- Second token-convergence pass across settings, management, about, welcome, queue/steer, attachment, and subagent surfaces (residual 7px-radius cluster, floating popover radii, scattered control heights, off-scale paddings), plus documented exceptions and the agreed Phase 1-4 process-area roadmap in `docs/web-visual-language.md`.

### Release assets and portable archive

- Releases publish `pi-chat-setup.exe` alone; checksum/manifest sidecars are still generated and verified in CI but no longer uploaded, so a release page shows one installer plus GitHub's two source archives. Version-tag releases additionally publish `pi-chat-portable-<版本>.zip` (app payload with Windows launcher scripts; runs anywhere Node 22.19+ and Pi are available), restoring the cross-platform deployment path without official non-Windows support. The broken ~192 KB historical bootstrapper was removed from v0.5.2 assets.

### Review fixes and Runtime startup investigation

- Sandbox WinForms test log initialization explicitly; Windows known-folder APIs ignore `LOCALAPPDATA` overrides. Verify readable failure handling without modifying the real user's launcher logs.
- Quote Retry's full script path. Identify a running installation even with system Node and relative app argv by bounded read-only working-directory inspection; retain fail-closed checks and never stop another checkout. Supported launcher fallback now passes an absolute app entry.
- Prefer synchronous Node load hooks for the same process-local RPC patches, retaining the original async compatibility fallback. Warm-cache isolated measurements reduce adapter overhead; they do not prove the observed 65-second cold-start incident is eliminated. See `docs/runtime-startup-investigation-2026-10-14.md`.
- Main CI publishes a commit-addressed, verified Setup artifact after all gates, without creating/moving tags or overwriting Release assets.

### Separate Git and Setup launch entries

- Generate source-checkout shortcuts as `Pi Chat Git` / optional `Pi Chat Git PWA` in a separate Start-menu group. Leave Setup-owned generic shortcuts untouched; installer tests guard against claiming the Git names.

### Web-default launch and private Node checks

- Default Setup completion and primary shortcuts to Web in the system default browser; add a tracked `Pi Chat Web.lnk` in the installation root and an explicit Desktop Web alias. Keep `Pi Chat PWA` as an optional Start-menu entry, with browser application setup owned by the browser.
- Retain the native launcher process handle so fast nonzero exits cannot become a null-to-zero false success. On a different build at 30170, show a readable conflict instead of opening the wrong instance.
- Encode the Chinese WinForms launcher with a UTF-8 BOM for Windows PowerShell 5. Add real hidden-WinForms checks for readable Chinese failure/buttons, Web/PWA dispatch, and no browser open after failure.
- Verify npm and actual app/Web/handshake serving under the installed private Node; preserve isolated agent/session data and the production listener.

### One complete Windows Setup

- Replace the IExpress/Web downloader with one Inno Setup EXE embedding App + private pinned Node/npm. No Web EXE or portable application ZIP is produced; historical v0.5.2 assets remain unchanged.
- Use native per-user installation, destination selection, shortcuts and uninstall. Refuse upgrade/uninstall of an active destination without killing it; preserve Pi user data and unknown files. Compare file-handle identities as well as launch paths so Windows short-path and junction aliases cannot bypass the running-install guard.
- Reuse existing Pi without upgrading it. Missing Pi is an explicit optional online action; skipping it or a network failure leaves the base application installed and usable for connection recovery.
- Pin and checksum Node/compiler downloads on the build machine, validate the built application under the actual private Node, and emit one Setup with SHA256/schema-2 identity sidecars.
- Add isolated real-installer install/upgrade/uninstall tests, existing-Pi/no-network behavior and published-asset immutability guards. Update README to distinguish the new main-branch installer from the old released online bootstrapper.

### Usability

- Runtime capacity rejection now states concrete occupancy (n/N hot conversations, how many are busy) and explicitly notes the Session history remains readable; error code `RUNTIME_CAPACITY_EXHAUSTED` is unchanged.
- Recorded the 2026-10 external review dispositions (hot capacity, lifecycle, Files/Gate) in `docs/review-dispositions-2026-10.md`.

### Large-history fixes

- Preserve naming-entry IDs and parent links in Session outlines so a rename/Fork boundary cannot hide earlier turns; invalidate old derived index caches once.
- Keep the index cache beside an explicitly configured Session root, including environment-selected E2E roots, instead of overwriting the default user's cache.
- Preserve cumulative history counts and the earlier-history entry point when a hot/bootstrapped view contains only a bounded suffix; idle hot views no longer attempt an oversized full snapshot first.
- Continue before a persisted message when a cumulative tail stops growing at its byte budget. Older pages use active-branch identity, bounded materialization and file-version/record-hash checks, without starting a Runtime or editing JSONL.
- Round partial-window requests to valid ten-turn increments, and prepend pages through the existing cache writer without dropping live state, unsent drafts or pending SSE tails.

### Prompt persistence fix

- Reconcile image prompts against a request-addressed fingerprint of Pi's post-preflight user message, rather than assuming original text/image bytes survive Pi image normalization unchanged. The raw pending bubble is retired only after a matching persisted JSONL row is observed, including after reload.
- Keep late acceptance, repeated image prompts, image-only first turns and rewritten history fenced by the existing Prompt identity and persistence owners; no message is removed merely because a run settled.

### Licensing

- Adopted the MIT License for this repository. `LICENSE` (copyright 2026, oopjoy and Pi Chat contributors) now applies to the code and documentation; `package.json` declares `license: MIT`, the README license section was updated, and the Windows release ZIP ships `LICENSE`. Releases published before this change (through v0.5.2) carried no open-source license.

### Desktop usability fixes

- Preserve Windows path separators and command backslashes in tool summaries; long paths retain their filename instead of truncating it away.
- Return keyboard focus to the process summary when collapsing from its footer, without scrolling a retired or reopened card on a later frame.
- Ignore superseded resource scans when switching Settings categories; scan failures no longer claim that no resources are installed.
- Give npm-command Copy explicit success, unavailable-clipboard and permission-error feedback while keeping the complete command selectable; copying no longer clears an unrelated upgrade error.
- Retire the previous Pi update action while rechecking and clarify that busy conversations reject an update rather than automatically scheduling it.
- Document the current Windows desktop-only maintenance scope; retain existing narrow-layout code without expanding mobile support.

## 0.5.2

### Productization

- Added a single-file Windows Setup (`pi-chat-setup.exe`) that installs an isolated app into `%LOCALAPPDATA%\PiChat`, downloads and checksum-verifies a private Node.js 22 runtime, detects an existing Pi first with a PiChat-managed fallback in Pi's native `~/.pi/agent/install` layout, creates desktop and Start-menu shortcuts, and registers a Windows uninstaller.
- Node.js and npm registry downloads fall back to the npmmirror mirror so first-run installs survive networks where nodejs.org or registry.npmjs.org are unreachable; the npmjs SHA256 verification is unchanged.
- Setup refuses to run while Pi Chat is running (port 30170 or a Node process under the install root) instead of failing mid-upgrade on file locks.
- The About panel can now update the Pi Runtime in place: managed installs switch the pinned `current-version` pointer after a verified install; npm-global installs run an explicit `npm install -g` (keeping the user's Pi CLI in lockstep) with rollback, both gated by the full lifecycle quiescence barrier. Custom Pi entries are never modified.
- Update availability reporting distinguishes managed, npm-global, and custom entry sources so the UI only offers upgrade paths that actually apply.

### Fixes

- Optimistic user prompts now reconcile after Runtime settlement instead of lingering when the persisted echo becomes visible through a different projection path.
- Oversized Session JSONL files keep at least the most recent 50 turns readable across cold views, active bootstrap, hot recovery, workspace, and read-only paths instead of failing the whole view.
- npm-cli discovery for in-app updates covers npm bundled inside the Node.js installation (the common Windows layout) in addition to a PiChat-bundled runtime.
- The Setup console wrapper sets a UTF-8 codepage so Chinese install messages render on non-Chinese system codepages.

## 0.5.1

### Reliability and maintainability

- Integrated the audited Runtime maintenance, serialized SessionProjection, and safe SSE lifecycle fixes from the review chain.
- Added exact LaTeX backslash-delimiter rendering and source-copy coverage without changing Session JSONL or provider payloads.
- Preserved pending local turns after confirmed transcript history so queued work cannot split an earlier tool process or final answer.
- Replaced whole-App recovery/settings proxies with explicit capability ports and compile-time boundary contracts.
- Added guarded Pi package discovery, runtime-entry validation, connection setup, and lifecycle-safe service-only restart; no automatic installation, download, or credential storage is introduced.
- Stabilized the last-window auto-shutdown test boundary so Windows scheduler jitter cannot turn a passing idle-phase check into a release-gate failure.

### Maintainability

- Enabled React Hooks ordering checks as an ESLint error and dependency checks as warnings.
- Ratcheted the type-debt guard to the current verified floor: `732 / 32 / 37 / 8` for explicit `any`, `Record<string, any>`, `as any`, and `new Proxy`.
- Replaced the remaining generic callback/host bags in Compact, Runtime Event, and Prompt Route orchestration seams with explicit capability contracts.
- Added descriptive streaming metrics for first visible wire frame to guarded paint opportunity and optional React render profiling; production cadence remains unchanged.
- Added diagnostic Markdown-only and KaTeX-only streaming fixtures to separate parser/layout costs before any Progressive RichText experiment.
- Removed the experimental Pi Runtime Bundle path; Pi Chat now uses the installed Pi Direct RPC entry and keeps startup diagnostics focused on initialization.
- Workspace Files now revalidates transcript-derived paths against the current Session Workspace before displaying them, hiding stale paths left by moved or deleted checkouts.
- Direct startup benchmarking now separates transport-ready from capability-ready and records metadata-only Extension import/factory timing when the direct loader exposes those boundaries.

## 0.5.0

### Reliability and maintainability

- Split browser Pi event handling into message/streaming, Runtime lifecycle, workspace/session, queue/extension, and failure/control domains without changing SSE admission, generation fencing, or terminal ordering.
- Split Prompt sending into preparation, Runtime/Draft warm-up, acknowledgement reconciliation, and failure/uncertain-delivery stages.
- Bound New first-send Server Prompt identity before retry lifecycle frames can race the browser acknowledgement.
- Removed the nested Prompt-route Proxy while preserving active Primary `running` write-through semantics.
- Replaced residual server/browser `any` authority aliases with explicit projection and Runtime types.
- Preserved the App/server decomposition targets and the full authority-first behavior contract.

### Verification and package scope

- `npm run typecheck`, `npm run test:preflight`, the complete source suite, committed-text checks, and diff checks pass.
- `pi-chat-windows-0.5.0.zip` is the runnable Windows package. GitHub-generated source archives remain source-only development inputs.
- Pi Chat remains loopback-only, local-first, and Windows-first.

## 0.4.8

See [`release-notes-v0.4.8.md`](release-notes-v0.4.8.md) for the Windows-first maintenance release notes.

## 0.4.7

See [`release-notes-v0.4.7.md`](release-notes-v0.4.7.md) for the stability-preview release notes.

## 0.4.6

### Conversation continuity and presentation

- Restored the centered New-conversation welcome surface with the Pi bear mark, title, description, and an always-visible new-conversation workspace path selector.
- Empty active Primary Sessions now use the New presentation without waiting for sidebar inventory, preventing a transient pathless legacy welcome screen during startup and navigation.
- Local optimistic User turns now reconcile conservatively with their authoritative persisted JSONL rows, preventing duplicate bubbles while preserving two genuinely identical prompts as separate turns.
- Completed process rows retain their frozen final run duration after settlement, SSE recovery, and Session navigation.
- Scroll restoration is bound to the Pane identity actually committed to the DOM, with a tighter bottom tolerance to avoid restoring the wrong Session position; bottom-pinned timelines remain anchored through delayed image, font, and post-paint layout shifts.
- Fork/clone-created Sessions now receive a durable `（Fork）` display suffix from Pi's `parentSession` metadata, so copied conversations remain distinguishable after refresh and restart.
- Image attachments are no longer blocked by provisional or unsupported `ModelInfo.input` metadata in the browser; only local payload safety limits are checked before forwarding, and the upstream model decides whether it can interpret the images.
- Restart and cold-start bootstrap recovery no longer lets a persisted Session fall through to the New welcome; the centered logo, workspace selector, and New composer presentation are reserved for actual New state.
- The Composer Model control remains editable while Runtime model discovery is pending, using a bounded browser-local advisory catalogue when available; the server reports pending versus settled-empty discovery, and every selected model is revalidated against the target Runtime at Send.
- Accepted ordinary prompts remain recoverable across an immediate F5 while JSONL catches up, including their captured Model and Thinking settings; this server-owned projection never enters Pi JSONL or provider payloads.
- Queue and native Steer projections are revision-fenced so stale Session views, cache entries, and reconnects cannot resurrect completed queue rows or erase newer pending Steers. Pending native Steers survive refresh separately and enter the transcript only after verified Pi consumption.
- EventSource now keeps one transport connection while React callbacks update, preventing adjacent stream frames from being lost during render commits and reducing unnecessary reconnect/listener churn.

### Settings and supportability

- Settings now includes a `关于` panel with Pi Chat/Pi Runtime versions, build revision/fingerprint, Web/service consistency, Primary Runtime state, explicit diagnostic export, and on-demand GitHub Release checks. Update checks never download, install, restart, or deploy.
- Startup diagnostics now retain the selected Bundle/direct backend and metadata-only child-entry, Bundle, Extension import, and Extension factory timing phases.

### Runtime/SSE continuity

- A transient EventSource/token reconnect no longer clears the visible running turn, Queue, Steer, or streaming wire before fresh bootstrap authority arrives. A real process-epoch replacement still performs the full process-owned reset after the replacement `ready` frame.
- Fast mode is now explicitly scoped to the live Runtime generation. Primary replacement clears the old server/browser projection at `starting`; only a current-generation Extension status can enable it again.
- Generated Subagent Fork histories are excluded from the normal Session sidebar even when inherited names carry the derived `（Fork）` suffix; stale positive index-cache entries are invalidated while user-created Fork conversations remain visible.
- Hot Session views now reveal an accepted local queued turn when an authoritative active queue no longer contains its ID, covering a missed `queue_dispatch`/`message_start` pair without synthesizing a persisted Pi record.

### Windows cold Runtime startup

- Primary, Secondary, draft, and recovery clients now share one immutable per-host launch plan while retaining one independent Node/Pi RPC process per executing Session; no shared SDK host, broker, or process rebinding is introduced.
- Before an initial prompt is accepted, a New-draft Runtime now retries one whole child process after a readiness timeout, matching cold persisted-Session recovery without risking a duplicate prompt or JSONL writer.
- Definite Composer failures retain the server-provided cause beside the restored draft, so Runtime startup timeouts are no longer presented as if the prompt content must be edited.
- Windows builds include a Pi `0.85.1` RPC acceleration Bundle. It is selected only when the installed Pi version, the fixed build recipe, every bundled-input hash, platform tuple, and every generated Runtime artifact hash match; explicit/custom or mismatched Pi installations remain direct, and missing Pi still permits JSONL-only browsing.
- The bundled Extension loader uses Pi's `VIRTUAL_MODULES` graph to preserve one kernel/API identity, while image resizing retains a separate worker and external Photon/WASM package. Package-relative resources and CLI authority remain with the verified global Pi installation.
- Spawn-to-ready diagnostics now distinguish parent spawn, child preload, startup request allocation/write, first stdout, and transport readiness without entering RPC payloads, JSONL, SSE, scheduling, or writer authority.
- Added a fresh-process, copied-Session startup benchmark. With Pi `0.85.1` on the investigated Windows machine, three installed-profile probes improved from about `5.2–5.4s` direct to `2.7–2.9s` bundled; three core-only probes improved from about `1.2s` to `0.43s`. These figures do not claim an OS- or Defender-cold cache.

## 0.4.5

### Streaming and long-session performance

- Cumulative assistant output now uses authoritative checkpoints and append-only deltas, stable projected message identities, progressive Markdown/GFM/KaTeX rendering, sequence-gap recovery, and a canonical terminal render without changing the production $50$ ms latest-wins cadence.
- Large Session JSONL files now retain committed byte offsets and parse only verified append-only suffixes, with rewrite fallback and active-branch semantics. Session inventory scans also retain bounded negative results and avoid repeated cold-start work.
- Provider terminal reconciliation prevents duplicate live/persisted replies without globally deduplicating independent assistant turns.

### Session management and reliability

- Cold or reclaimed Sessions can compact through their own restored RPC binding, and compaction completion clears stale tool state while returning to the normal blue running presentation.
- Clone and Fork create independent cold Sessions through the source Session's single RPC writer. Both require confirmation; Fork previews its exact history boundary and restores the selected User message as an editable, unsent draft.
- Fork provenance is stored atomically in a Pi Chat sidecar rather than either Pi JSONL. Forked conversations show a cold navigation link to their source, fail closed when the source is deleted, and retain duplicate-operation guards when a committed outcome needs recovery or index confirmation.

### Workspace and Composer interface

- The right-side Workspace Inspector now provides `Files` and `Changes`: Files lists the current Session's most recent successful Edit/Write targets with bounded fail-closed previews, while Changes retains the unified Edit projection.
- The file list/preview split is keyboard and pointer resizable, and code previews support readable typography plus horizontal scrolling.
- The Composer model selector is smaller and name-first while retaining model IDs on hover.

### Verification and package scope

- TypeScript checks, the isolated $964$-test unit suite ($960$ passed, $4$ platform-skipped), and all $19$ Playwright scenarios pass.
- `pi-chat-windows-0.4.5.zip` is the runnable Windows package. GitHub-generated source archives are source-only development inputs.
- Pi Chat remains loopback-only and local-first; this release does not add remote hosting, a desktop shell, or a replacement Pi agent loop.

## 0.4.4

### Conversation reliability

- Prevented a final live assistant snapshot from rendering a second copy when its complete reply has already reached the persisted active turn, including provider frames that omit or rewrite the terminal timestamp. The reconciliation is limited to that explicit live-versus-persisted handoff; separate persisted assistant turns are never collapsed merely because their text matches.
- Sanitized the distinct provider failure mode where one assistant text payload contains two byte-for-byte copies of a substantial complete response, without rewriting Session JSONL.
- Local intercom coordination messages now fold after $10$ source lines and provide accessible expand/collapse controls.

### Composer and native Steer presentation

- Model and Thinking controls retain the last confirmed model catalogue during transient empty Runtime metadata refreshes instead of becoming temporarily unavailable.
- Accepted native Steer messages now appear immediately in a separate waiting section, remain out of the ordinary prompt queue and transcript until Pi confirms consumption, and clear through the existing authoritative consumption or lifecycle paths.

### Package scope

- `pi-chat-windows-0.4.4.zip` is the runnable Windows package. GitHub-generated source archives are source-only development inputs.
- Pi Chat remains loopback-only and local-first; this release does not add remote hosting, a desktop shell, or a replacement Pi agent loop.

## 0.4.3

### Runtime, RPC, and settlement recovery

- Primary startup now uses one 60-second `get_state` readiness request, reuses that state for compatibility validation, and recovers failed children through single-flight mutation boundaries without deleting Session history or changing user configuration.
- Post-settlement Primary and Secondary FIFO barriers use independent 60-second reads, so an ordinary coalesced query cannot lend them a shorter timeout or allow stale RPC frames into the next turn.
- Abort timeouts distinguish "accepted and still settling" from failure; queue, Steer, and terminal bookkeeping remain generation-scoped while slow Pi/tool shutdown completes.
- RPC stream listeners and JSONL parsing are isolated from handler exceptions, process-level rejection/exception diagnostics are retained, and crashed Runtime recovery releases stale dispatch locks instead of permanently stranding queued prompts.

### Reload, multi-session, and authority hardening

- Bootstrap, SSE readiness, handshake leases, replacement processes, navigation, Session views, prompt acknowledgements, failures, and cache refreshes are guarded by process/run/navigation authority so stale A-to-B-to-A continuations cannot repaint or lock a newer pane.
- F5 and replacement handshakes use temporary page leases that expire unless promoted by SSE, avoiding both premature last-window shutdown and leaked page ownership.
- A default New view stays local until its first prompt, preserves its captured workspace, and does not create an empty JSONL or eager Secondary Runtime.
- Prompt/Steer admission, recovery, queue ordering, compaction settlement, and first-token timing have expanded deterministic regression coverage.

### Streaming and Composer behavior

- Healthy SSE connections coalesce cumulative assistant snapshots per client and Session at the browser render cadence before JSON serialization; terminal/tool/lifecycle frames flush the newest snapshot first, reducing bursty catch-up when several conversations stream in parallel.
- Primary-relevant Composer editing is disabled until Runtime readiness, while healthy Secondary panes remain independent. Ready drafts accept image attachments immediately and forward them without a client-side model-capability gate, while preserving text and previews on genuine transport/runtime failures.
- Confirmed slash-command inventories survive transient empty Runtime refreshes, and capability snapshots are scoped to the exact Primary generation and model shape.

### Conversation and workspace interface

- Per-reply model and thinking strength render once above the full thinking/tool process. The active turn receives stable metadata from its first frame, removes the redundant `Pi 正在工作…` placeholder, and reveals its generated time only after streaming fully settles; the copy action remains at bottom-right.
- New-draft workspace paths have an accessible hover/focus dropdown populated from the complete Session directory inventory, ordered by recent use and deduplicated case-insensitively. Quick selection remains local until the first prompt, while the native folder browser remains available for new directories.
- Provider hover text follows each model row, sidebar/runtime status retains concise failure reasons, and completed compaction/tool state no longer leaves stale spinners or paused follow-up prompts.

### Verification and package scope

- Local validation passes TypeScript checks, diff checks, and 526 source tests.
- `pi-chat-windows-0.4.3.zip` is the runnable Windows package. GitHub-generated source archives remain development inputs and require dependency installation plus a source build.
- Pi Chat remains loopback-only and local-first; this release does not add remote hosting, a desktop shell, or a replacement Pi agent loop.

## 0.4.2

### Startup and recovery reliability

- Primary startup now gives its initial `get_state` RPC a single 30-second readiness budget, avoiding the former 2-second timeout/retry path that could leave an uncancellable read outstanding and report a misleading in-progress error.
- A failed initial Primary readiness probe now recovers through the existing single-flight controller when a real Primary mutation or first New draft needs it; read-only JSONL history remains available without warming or mutating a Runtime.
- Primary compatibility validation reuses the successful startup state instead of immediately issuing a duplicate `get_state` request, while preserving the legacy fallback for compatible embedded test doubles.

### Workspace, Gate, and verification follow-ups

- Default-workspace updates now serialize in-process persistence, retry transient Windows replacement failures, and converge across windows/processes without rebinding a live Runtime cwd or changing an existing draft's captured workspace.
- Cold-history Gate choices remain Session-scoped next-prompt intent only; Runtime-confirmed Gate state is kept separate so a staged cold preference cannot auto-authorize a prompt before synchronization.
- Added regression coverage for slow startup readiness, duplicate-read protection, Primary failed-state recovery, Gate confirmation boundaries, and concurrent workspace-state replacement retry.

### Windows CI reliability

- Windows CI tests now resolve compiled inputs through `PI_CHAT_DIST_DIR`, matching the workflow's isolated build rather than assuming a live `dist/` directory exists.
- Shortcut WorkingDirectory verification canonicalizes equivalent Windows 8.3 short-path and long-path spellings.
- Startup smoke now waits independently for the asynchronous Primary RPC capability probe to complete after HTTP handshake readiness, eliminating a nondeterministic missing probe-log race on GitHub-hosted runners.
- The workflow uses `checkout@v5`, `setup-node@v5`, and `upload-artifact@v6`; project commands continue to run on Node 22.

### Package scope

- This is a Windows local-first package release. The GitHub source archive is for development; `pi-chat-windows-0.4.2.zip` is the runnable package and still requires a supported Node runtime plus a globally installed, authenticated Pi.

## 0.4.1

### Reliability convergence

- Cold JSONL history is strictly view-only: browsing, search, scrolling, pagination, and composer focus do not create a Secondary Runtime; real write or control intent activates the Session through a single-flight readiness path.
- New drafts have their own selected working directory, while live Primary and Secondary Runtime cwd bindings remain immutable. Fresh Windows installations default future drafts to the current user's Desktop; existing saved workspace choices are retained.
- The first New prompt now submits Runtime creation, Model, Thinking, Gate synchronization, and prompt admission as one transaction. A bounded JSONL-visibility retry replaces the provisional `新对话` title with the persisted first-turn title after a very fast completion.
- Multi-window lifecycle now distinguishes page presence from reconnectable SSE transport. The last explicitly closed browser/PWA page triggers only a quiescent $10$-second auto-shutdown grace; replacement pages and stale close beacons cannot terminate active work.
- Session navigation adds local search, Session pins, directory grouping, collapse/fixed preferences, and an authoritative Runtime activity projection. Manual Secondary release is removed; automatic safe reclaim remains.
- Build identity is embedded in both the Web bundle and server health/bootstrap responses, so restart handoff detects mismatched frontend/server artifacts.

### Safety, maintainability, and verification

- Hardened loopback API admission, exact handshake/host handling, Runtime provenance, prompt reconciliation, capacity reservations, queue/settlement barriers, and cold-history cache freshness.
- Added explicit feature-surface, frontend state-ownership, and timing-contract documentation. The reliability-convergence architecture is frozen: future coordination changes require a reproducible correctness, security, or measured user-facing problem.
- Playwright now gives each test an isolated local server and dynamic port. Focused tests cover pane authority, draft workspace ownership, Runtime event transitions, route admission, persistence races, and session navigation.
- Validation: `npm run typecheck`, `npm test` ($413$ passing tests), and `npm run test:e2e` ($9$ desktop/mobile applicable tests passing; $9$ intentionally project-skipped).

### Known boundaries

- Pi Chat remains a loopback-only local Web/PWA client; it does not provide remote access, public deployment, Electron, a replacement Pi agent loop, or a plugin platform.
- Package version $0.4.1$ is a source release; generated `dist/`, local Session JSONL, test output, and subagent artifacts are intentionally excluded from Git.

## 0.4.0

### Session-first availability

- Open the HTTP listener and persisted Session index before Primary Pi finishes starting, so saved JSONL conversations remain immediately browsable during Runtime startup, recovery, or compatibility failure
- Expose explicit Primary readiness (`starting`, `ready`, or `failed`) with generation tracking; unavailable read paths issue zero Primary RPC requests while Primary-only mutations return a stable `PRIMARY_RUNTIME_UNAVAILABLE` response
- Re-run the full RPC capability probe after every Primary recovery, and require that process-wide compatibility proof before creating or recovering a Secondary Runtime
- Keep already healthy Secondary workers usable if Primary later fails, while each new or recovered Secondary still verifies its own `get_state` response

### Runtime, transport, and navigation resilience

- Treat SSE/EventSource as a reconnectable transport rather than a service-lifecycle lease: disconnects, write failures, and slow-client backpressure now close only the affected connection
- Preserve explicit shutdown through the close API, last-window policy, restart handoff, and process signals, with typed shutdown reasons in service logs
- Add authoritative reconnect reconciliation so terminal assistant messages are refreshed without duplication after a dropped EventSource
- Cache per-Session history, revisions, terminal leases, overlays, and reading positions while rendering only the selected Timeline; stale HTTP, SSE, warm, model, queue, and extension results cannot repaint a newer destination
- Prepare a cold Session Runtime on composer focus or first mutation without blocking reading, switching, or JSONL history access

### Interface and compatibility

- Distinguish dormant history (`历史会话 · 发送时准备 Pi`) from resident Runtime state (`Pi 已驻留`) without conflating Runtime residency with browser-window control ownership
- Keep completed cold and hot conversations visually equivalent through the same Timeline, Markdown, KaTeX, tool, copy, image, and scrolling presentation
- Verified Pi Chat against Pi `0.83.0`, including real RPC command/model/state/statistics loading with no extension errors
- Added focused readiness, recovery, navigation, Runtime admission, sole-client reconnect, slow-client backpressure, Sidebar semantics, and Playwright coverage

## 0.3.6

### Reliable local-first sessions

- Reworked Secondary Runtime admission, reclaim, and draft handoff so an empty draft cannot be reclaimed while its browser handoff or async emptiness probe is in flight
- Queued Secondary prompts now perform the same acceptance bookkeeping as direct prompts: sidebar admission, branch-recency tracking, and snapshot warming occur after Pi accepts the prompt
- Session view reconciliation now has an explicit SSE invalidation classifier, preventing old snapshots from overwriting newer queue, confirmation, Gate, control, process-status, stream, or transcript state
- Protected optimistic user turns render exactly once when a background Session refresh races prompt acknowledgement
- Terminal SSE assistant messages retain repaired cumulative content, and cache/reclaim/SSE heartbeat accounting has additional concurrency coverage

### Composer, history, and Gate UX

- Rebuilt the compact composer controls and responsive conversation shell; Model, Thinking, Gate, usage, queue, attachment, and stop controls stay session-scoped during streaming
- Assistant footers show the persisted per-reply thinking strength alongside model metadata when available
- Historical session snapshots restore persisted Model and Thinking settings without activating cold Runtimes
- Gate now has only **严格** and **放行** modes. Strict always confirms `write` / `edit` and performs best-effort confirmation for recognized high-risk Bash commands; it does not claim to sandbox arbitrary shell side effects
- Improved process disclosure, read-only edit diffs, queue/local-turn reconciliation, PWA EventSource recovery, navigation epoch isolation, and Windows launcher readiness

### Validation and packaging

- Added focused race, lifecycle, session-cache, SSE, Gate, UI, launcher, and Playwright coverage for the reliability changes
- Added Playwright E2E test scripts and ignores for generated reports

## 0.3.5

### Diff review and session safety

- Added a docked, resizable Diff sidebar that opens from completed `edit` rows without using floating windows or additional protocol data
- Kept Diff details bounded and isolated in the main chat layout, with matching top-bar controls and navigation positioning
- Preserved edit rows during streaming so in-progress, completed, and failed edits do not remount between different element types
- Prevented a failed prompt from a previous Session from restoring its draft text into the newly selected Session
- Unified process-row typography and removed redundant successful-tool completion labels

## 0.3.4

### Session and runtime reliability

- New drafts appear in the sidebar as soon as their first prompt is accepted, without waiting for a long-running response to settle
- Cold Sessions retain their own Model and Thinking preferences without eagerly starting a Runtime
- Rapid switching, stopping, deleting, compaction recovery, and background reconciliation no longer block the shell on slow Runtime probes
- Session sidebar status keeps running, queued, failed, and pending-confirmation states aligned with authoritative server state

### Gate, Markdown, and resource simplification

- Gate preferences survive Runtime recovery and update synchronously across UI and event handlers
- Streaming Markdown renders completed math incrementally without repeatedly building final source-copy offset maps
- Skills, Extensions, and Packages are now a read-only enabled-resource inventory; changes are made directly in their displayed folders while Model management remains editable
- Concurrent builds no longer delete another live Pi Chat process's staging tree

## 0.3.3

### Follow-up fixes

- SSE backpressure now coalesces and replays the latest cumulative assistant snapshot per Session instead of starving visible streaming until final resynchronization
- Rapid Session switches save scroll state against the conversation currently committed to the DOM, preventing positions from being assigned to the destination Session
- Remembered history windows are normalized to the server-supported 20-turn base and 10-turn increments, with the 10,000-turn maximum enforced

### PWA recovery

- New opens an instant local draft and starts a Secondary Pi Runtime only on the first real send
- Cold-start progress now distinguishes Runtime startup, prompt preparation, and Pi thinking without showing Stop prematurely
- Returning to a long-idle PWA proactively replaces a potentially half-open EventSource and refreshes the authoritative Session view
- Accepted prompts reconcile with persisted Session state when SSE frames are missed, so completed replies appear without a manual page refresh
- A compare-and-clear viewed-Session pin prevents delayed local-draft cleanup from unpinning a newer conversation

### Streaming stability

- Visible SSE heartbeats let the frontend detect stale foreground connections instead of relying only on `EventSource.onerror`
- Cumulative `tool_execution_update.partialResult` snapshots no longer enter browser SSE fanout
- Oversized SSE events are replaced with bounded diagnostics, while socket backpressure drops intermediate frames and requests authoritative resynchronization
- The frontend rejects unused cumulative tool snapshots before JSON parsing and safely reconnects after an unexpected oversized frame

## 0.3.2

### UX

- Gate permission requests now use a compact `Pi Chat Gate` dialog with explicit `Block` / `Allow` actions and no redundant Cancel button
- Gate and ordinary Extension requests share one dialog frame, with only provenance, content controls, and response semantics varying
- Long commands wrap inside the permission details area without producing a dialog-level horizontal scrollbar
- An expanded process card stays open while streaming tool steps complete
- Partial selections inside code blocks copy the selected plain text instead of the entire source block
- Changing model / thinking no longer freezes the whole shell (`settingsBusy` only locks those controls)
- Conversation process/message React keys stay stable while streaming thinking text grows (less remount flicker)

### Runtime safety

- Hot conversations are capped at five total: one Primary plus at most four Secondary Runtimes
- Capacity admission is serialized; the least-recently-used reclaimable idle Secondary is rested before a new activation
- When all Secondary Runtimes are busy or protected, the next activation receives HTTP `409` instead of interrupting live work
- Cold JSONL history views remain outside the hot Runtime limit

### Compatibility

- Gate dialogs recognize the stable `Pi Chat Gate · <tool>` protocol, the previous bundled Gate format, and current `Tool requires permission` requests
- Windows launch documentation now distinguishes shortcut installation from direct launch and reports a missing Pi executable clearly

### Stability (carried on 0.3.1 line, released as 0.3.2)

- Restart handoff health-check + automatic rollback to previous `dist` on candidate failure
- Empty New reuses this window’s idle blank draft; drafts are never shared across windows
- Contiguous tool/thinking steps fold into one process card during streaming
- Selected session survives refresh / reconnect; connection recovery after restart
- Appearance steppers, process disclosure, sidebar open animation, and related polish

## 0.3.1

### Stability (Windows restart)

- **Fix `EPERM` on “应用更新并重启”**: live `dist` is no longer renamed while the running Node process still holds handles under it
- Dist promote now runs in `restart-handoff` **after the parent PID exits**, then the new server starts
- Handoff waits for `/api/health` on the candidate; on failure it **rolls back** to the retained previous `dist` and restarts the old build
- Rename retries on `EPERM` / `EBUSY` / `EACCES` with short backoff
- Startup cleans abandoned `.pi-chat-dist-staging-*` / `.pi-chat-dist-previous-*` / `.pi-chat-dist-failed-*` trees
- Clearer promote error hints when a lock remains

### Stability (sessions & UI)

- Empty **New** reuses this window’s idle blank draft (no second spawn); drafts are never shared across windows
- Extension commands on a draft commit it before the next New
- Contiguous tool/thinking steps (persisted + live) fold into **one** process card during streaming
- Selected session survives refresh / reconnect; connection recovery re-bootstraps after restart
- Prompt admission is serialized per session so concurrent sends cannot bypass the queue
- Malformed JSON / oversized bodies return clean 400/413; missing static assets stay 404

### Safety

- Handoff always targets `dist/server/server/index.js` after promote (compiled entry), not a mid-lifecycle `import.meta.url` under a tree about to move
- Parent exit wait extended slightly; brief settle delay before promote on Windows
- Extension UI responses claim-then-send so transport failure remains retryable

## 0.3.0

### Stability & safety

- Session control: sole live window auto-claims; ghost / grace owners no longer flash “接管控制”
- Observing banner only for live foreign SSE owners; ~400ms frontend debounce
- Control grace reduced to 1.5s (reconnect-safe, less takeover flash)
- Extracted `PromptScheduler` and `SseHub` from `PiChatApp` for safer queue/SSE ownership
- Loopback-only listen remains hard-enforced; no remote escape hatch

### UX

- Composer: fixed 14px input size and slightly open letter-spacing (independent of reading size)
- Startup failure splash: Chinese copy, log summary, styled Open log / Retry / Close
- Success splash still hides before opening the Chat window
- Sidebar: remove green running title color; status dots remain the only runtime signal
- Long sessions: auto-load earlier turns when scrolling near the top (button kept)

### Compatibility

- Documented / verified against Pi **0.81.1** via RPC capability probe
- Package version set to **0.3.0**

### Docs

- Product boundaries and module map updated in `docs/architecture.md`
- README Pi version matrix and remote non-goal clarified for 0.3.x
