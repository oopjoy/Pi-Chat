# Windows Setup: one self-contained application installer

## Distribution contract

Stable v0.5.3 publishes `pi-chat-setup.exe` as the Windows installation entry
point and `pi-chat-portable-<version>.zip` for deployments with Node and Pi
already installed. SHA256 and JSON identity sidecars are generated and verified
inside CI but are not uploaded as Release assets. GitHub's automatic source
archives remain source-only. Published v0.5.2 assets are unchanged and retain
their old online-bootstrapper behavior.

The Inno Setup EXE embeds the compiled application, LICENSE/resources, launchers,
a private Windows x64 Node.js 24.22.0 LTS runtime including npm, and a pinned
Pi 1.3.0 snapshot. Application/Node installation has no runtime dependency on
GitHub or nodejs.org. Existing Pi is reused; a missing Pi is seeded offline from
the payload into `~/.pi/agent/install` and is never upgraded in place.

- Per-user installation; no administrator privilege, Electron or browser bundle.
- Default `%LOCALAPPDATA%\PiChat`; the destination page supports other paths.
- The finished page, Start-menu `Pi Chat`, and the desktop `Pi Chat Web` shortcut
  default to Web in the system default browser. Setup no longer creates a desktop
  `Pi Chat` icon. On upgrade it removes that leftover only when it belongs to
  this installation's PowerShell Web launcher and working directory, not a PWA
  or another checkout. The install root also
  contains a tracked `Pi Chat Web.lnk`; optional `Pi Chat PWA` remains in the
  Start menu. Browser install-as-app/profile setup is not performed by the installer.
- Existing Pi is detected and reused without upgrade or credential/config copy.
- Missing Pi is seeded from the bundled 1.3.0 snapshot (offline, including silent
  mode) into the managed install layout. Copy failure leaves the application
  installed and explains how to retry; it does not claim that a usable
  model/provider exists. Launch prefers a system Node 22.19+ and falls back to
  the bundled 24.22.0 runtime when the machine has none or an older version.
- Inno Setup owns file deployment, shortcuts and native uninstall registration.
  `pi-chat-setup.ps1` only checks running processes, detects Pi, or explicitly
  installs a missing Pi. No console Read-Host, app downloader or second uninstaller.
- Upgrade/uninstall refuses a Node process running from the destination, including
  system Node with relative `dist/server/server/index.js` argv. A bounded read-only
  Windows x86/x64 process-parameters query resolves that owner's cwd; an alive,
  uninspectable candidate fails closed. No process memory is modified. Neither
  installer nor uninstaller force-closes applications. A service in another
  checkout is not stopped; the launcher's existing fingerprint/port guard still
  refuses to take it over.
- Native uninstall removes installed files and this installation's runtime.env,
  but never deletes user `~/.pi/agent` state or managed Pi. Unknown files are not
  recursively erased. Legacy uninstall registration is retired only when its
  recorded InstallLocation equals the destination.

## Build

`installer-dependencies.json` pins the Node and Inno compiler versions and SHA256
values. The current private runtime is Node.js 24.22.0 LTS (win-x64). Downloads
happen only on the build machine. The official compiler is
prepared with its supported `/PORTABLE=1` option inside the build cache, not
installed system-wide. Cached archives are revalidated before reuse.

```powershell
npm run setup:inputs
# Build under an isolated temporary PI_CHAT_DIST_DIR, never live dist:
$env:PI_CHAT_DIST_DIR = Join-Path $env:TEMP ('pi-chat-candidate-' + [guid]::NewGuid())
npm run build
npm run build:setup -- --staging $env:PI_CHAT_DIST_DIR --output D:\PiChatBuild\pi-chat-setup.exe
```

For a release use `release:package` with the same verified staging tree and the
matching tag. It requires clean Git state and matching package/tag/HEAD/embedded
identity. Outputs:

- `pi-chat-setup.exe`
- `pi-chat-setup.exe.sha256` (basename-only checksum record)
- `pi-chat-setup.exe.manifest.json` (schema 2; Setup digest, application identity,
  Node archive checksum and compiler version)

Main pushes and PRs automatically run source-only **Source Checks** without
building or publishing artifacts. Use **Actions → Windows CI → Run workflow**
for explicit full verification. A successful
manual run on main publishes `pi-chat-setup-main-<full-commit>` as an Actions
artifact only after source, browser, artifact and real-installer gates. Its manifest uses
`tag: HEAD` and the exact checked-out SHA. This route requires no tag creation,
no tag move and no Release write permission. GitHub wraps the three files in a
transport ZIP; it is not a portable application distribution. Artifacts expire
after 30 days and normally require a GitHub login to download.

Pushing a `v*` tag automatically runs **Windows Release CI**, including all
source, browser, artifact and installer gates. It packages the Setup, calls
`portable-package.mjs` for the portable archive, retains the verified sidecars
as a CI artifact, and publishes only the EXE and application ZIP on the Release.
The portable archive lays out `server/`, `web/` and `build-identity.json` at the
extraction root; it does not bundle Node or Pi. Source archives are not runnable
binaries.

A separately authorized test-only publication may use
`v<package-version>-setup-preview.<first-12-characters-of-HEAD>`. Its tag must
resolve to the exact checked-out revision and its embedded package version must
still match. The same release gates apply, but GitHub marks it Pre-release and
explicitly not Latest. It does not move the stable version tag or require a
new application version just to test the installer.

By default an existing Release is immutable: automatic publication fails if
it already exists, never silently overwrites assets. Only an explicit operator
request can authorize replacing a stable Release under the same tag (as happened
for v0.5.3); record the old/new revisions, retarget that same tag, and rerun every
release gate. A same-version update is distinguishable by Build Revision, not by
the version string alone. Pin updates require explicit review and rerunning the
bundled-runtime checks; a pinned version is not an excuse to ignore security updates.

## Verification

`npm run test:setup` uses the actual bundled Node to build an isolated artifact,
compiles a test-identity Inno EXE, installs into an unusual temporary path, and
checks native installation/upgrade/uninstall, registration, missing-Pi startup,
existing-Pi reuse and missing-Pi offline seeding. It also verifies npm under the
private Node and that native uninstall removes the generated root Web shortcut.
The test owns its processes and
never launches a real model request, maps the live user sessions, writes the
production uninstall key or stops the production listener.

Installer and application logs are retained with the test staging path on
failure. Build-machine downloads are separate from user-machine installation;
Setup itself does not fetch Pi or Node from the network.

Manual checks still required before adoption: visible wizard/shortcut behavior
on a clean Windows profile, SmartScreen and antivirus feedback, and model-provider
authentication using the user's actual Pi configuration. The EXE is currently unsigned: embedding
Node is not code signing and cannot guarantee SmartScreen reputation.
