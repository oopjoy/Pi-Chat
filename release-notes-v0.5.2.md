# Pi Chat v0.5.2

## Productization release: one-file Setup, self-contained runtime, in-place Pi updates

Pi Chat v0.5.2 turns the previous developer-style install into a normal Windows application flow while keeping every authority boundary: Pi remains the sole authority for Runtime execution, Sessions, JSONL, Prompt delivery, retry, Steer, tools, models, and transcript state, and the Web core remains the only product surface.

## Pi Chat Setup

`PiChatSetup.exe` is a single-file Windows installer (no Electron):

- Installs the compiled app into `%LOCALAPPDATA%\PiChat\app`.
- Downloads and SHA256-verifies a private Node.js 22 runtime into `runtime\node` — the user never needs a system Node, and nvm/PATH skew cannot affect the service.
- Detects an existing local Pi and uses it by default; when no Pi exists it installs a PiChat-managed Pi Runtime into Pi's own native `~/.pi/agent/install` layout, sharing sessions, settings, skills, and credentials with the user's Pi CLI without duplication.
- Creates desktop and Start-menu shortcuts (PWA and Web views) and opens Pi Chat on completion.
- Registers a Windows uninstaller (Settings → Apps → Pi Chat → Uninstall) that removes the install root and shortcuts while deliberately preserving `~/.pi/agent` user state.
- Falls back to the npmmirror mirror for Node.js and npm registry downloads so installs work on networks where nodejs.org or registry.npmjs.org are unreachable; checksum verification is unchanged.
- Refuses to install or upgrade while Pi Chat is running instead of failing on file locks mid-upgrade.

## In-place Pi Runtime updates

The About panel can now upgrade Pi directly instead of linking to npm:

- Update checks remain explicit, read-only, and guarded by the local API authority.
- Managed installs install the pinned version into `releases/<version>`, then atomically switch the `current-version` pointer after the full lifecycle quiescence barrier.
- npm-global installs run an explicit `npm install -g @earendil-works/pi-coding-agent@<version>` after confirmation, keeping the user's Pi CLI and the Pi Chat engine in lockstep (the shared `~/.pi/agent` state can never skew between versions); a failed upgrade rolls back to the previous version.
- Custom Pi entries are never modified; the UI only offers upgrade paths that apply to the detected install source.

## Fixes

- Optimistic user prompts reconcile after Runtime settlement instead of lingering after the persisted echo becomes visible.
- Oversized Session JSONL files stay readable with a bounded recent-turn window across cold, bootstrap, hot-recovery, workspace, and read-only paths.
- npm-cli discovery covers npm bundled inside the Node.js installation directory (the common Windows layout).
- The Setup console wrapper forces a UTF-8 codepage so install messages render correctly on non-Chinese systems.
