# Windows Setup: one self-contained application installer

## Distribution contract

The next release publishes only `pi-chat-setup.exe` as the user installation
entry point, plus its SHA256 and JSON identity sidecars. No Web bootstrapper or
portable application ZIP is produced. GitHub's automatic source archives remain
source-only. Published v0.5.2 assets are unchanged and retain their old online
bootstrapper behavior; this is the current main-branch implementation.

The Inno Setup EXE embeds the compiled application, LICENSE/resources, launchers,
and a private Windows x64 Node runtime including npm and Node's license notices.
Application/Node installation has no runtime dependency on GitHub or nodejs.org.
Only the optional Pi installation uses the network.

- Per-user installation; no administrator privilege, Electron or browser bundle.
- Default `%LOCALAPPDATA%\PiChat`; the destination page supports other paths.
- The finished page, primary Start-menu entry and Desktop entries default to
  Web in the system default browser. The install root also contains a tracked
  `Pi Chat Web.lnk`; optional `Pi Chat PWA` remains in the Start menu. Browser
  install-as-app/profile setup is not performed by the installer.
- Existing Pi is detected and reused without upgrade or credential/config copy.
- Missing Pi is not an application-installation failure. The finished page offers
  optional Pi installation, then application launch. Both actions are skipped in
  silent mode. Download failure leaves the application installed and explains
  how to retry; it does not claim that a usable model/provider exists.
- Inno Setup owns file deployment, shortcuts and native uninstall registration.
  `pi-chat-setup.ps1` only checks running processes, detects Pi, or explicitly
  installs a missing Pi. No console Read-Host, app downloader or second uninstaller.
- Upgrade/uninstall refuses a Node process running from the destination; neither
  installer nor uninstaller force-closes applications. A service in another
  checkout is not stopped; the launcher's existing fingerprint/port guard still
  refuses to take it over.
- Native uninstall removes installed files and this installation's runtime.env,
  but never deletes user `~/.pi/agent` state or managed Pi. Unknown files are not
  recursively erased. Legacy uninstall registration is retired only when its
  recorded InstallLocation equals the destination.

## Build

`installer-dependencies.json` pins the Node and Inno compiler versions and SHA256
values. Downloads happen only on the build machine. The official compiler is
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

A test-only publication may use
`v<package-version>-setup-preview.<first-12-characters-of-HEAD>`. Its tag must
resolve to the exact checked-out revision and its embedded package version must
still match. The same release gates apply, but GitHub marks it Pre-release and
explicitly not Latest. It does not move the stable version tag or require a
new application version just to test the installer.

Do not overwrite an existing Release. Publication fails when a Release already
exists. Pin updates require explicit review and rerunning the bundled-runtime
checks; a pinned version is not an excuse to ignore runtime security updates.

## Verification

`npm run test:setup` uses the actual bundled Node to build an isolated artifact,
compiles a test-identity Inno EXE, installs into an unusual temporary path, and
checks native installation/upgrade/uninstall, registration, missing-Pi startup,
existing-Pi reuse and optional online failure. It also verifies npm under the
private Node and that native uninstall removes the generated root Web shortcut. The test owns its processes and
never launches a real model request, maps the live user sessions, writes the
production uninstall key or stops the production listener.

The optional download-failure test changes .NET proxy settings only inside its
one child PowerShell process; it never edits machine network settings. Installer
and application logs are retained with the test staging path on failure.

Manual checks still required before adoption: visible wizard/shortcut behavior
on a clean Windows profile, SmartScreen and antivirus feedback, and successful
optional Pi download/authentication. The EXE is currently unsigned: embedding
Node is not code signing and cannot guarantee SmartScreen reputation.
