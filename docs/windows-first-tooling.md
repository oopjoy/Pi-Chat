# Windows-first browser tooling

The interactive browser helper at:

```text
C:\Users\opjoy\.pi\agent\skills\pi-skills\browser-tools
```

uses an isolated Chromium-compatible profile and CDP on port `9222` by default.

## Launcher contract

```powershell
node browser-start.js
node browser-start.js --profile
```

The launcher now uses Node filesystem and process APIs rather than Unix shell commands. It does not invoke `mkdir -p`, `rm`, `rsync`, or a shell-wrapped executable path.

On Windows it:

- searches explicit and standard Chrome/Edge installation paths;
- keeps the isolated profile under `%LOCALAPPDATA%\browser-tools`;
- passes executable paths and arguments directly to `spawn`;
- removes only stale Chromium singleton markers;
- launches the browser as a detached child and waits for port readiness;
- copies the default Chrome profile only when `--profile` is requested;
- excludes active Session/Tabs files from profile copying;
- waits for the CDP endpoint before reporting success;
- supports paths containing spaces, parentheses, and `&` without shell quoting.

Optional environment variables:

```text
PI_CHAT_BROWSER_EXECUTABLE   Explicit Chrome/Edge executable path
BROWSER_START_PORT           CDP port; defaults to 9222
BROWSER_START_TIMEOUT_MS     Startup timeout; defaults to 15000ms
```

The browser helper is an agent-side development tool. It is not part of the Pi Chat Windows release ZIP and does not change the Pi Chat listener, Session root, or live `dist` tree.

## Verification boundary

The launcher platform helpers were checked with synthetic Windows paths and executable discovery inputs, plus Node syntax checks. A real browser launch remains an isolated local-browser check and must use a temporary profile and a non-live Pi Chat fixture when testing the product UI.
