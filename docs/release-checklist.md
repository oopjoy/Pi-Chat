# Release Checklist

Work from isolated staging. Never overwrite live dist, restart the current
service, or interrupt active Sessions without an authorized quiescent window.

本轮工作区验收结果见 [维护收尾验收 — 2026-10-25](closeout-acceptance-2026-10-25.md)。
它记录自动化通过、跳过和待人工确认项，不代替下方针对最终发布 revision 的检查。

## Source and artifact gates

- [ ] Typecheck, lint, writer-boundaries, type-debt and committed-text checks pass.
- [ ] `verify:unit` passes in its own temporary staging directory.
- [ ] Desktop browser and forced-colors checks pass in separate staging. Retained
      mobile regressions may remain in CI, but no mobile product is promised.
- [ ] `verify:artifact` passes; missing package/runtime assets fail closed.
- [ ] `npm run test:setup` passes using the checksum-pinned private Node binary,
      not merely the developer/system Node. Installer test processes, agent/session
      directories and native uninstall identity are isolated from production.
- [ ] Node/compiler pin versions and SHA256 values in
      `scripts/installer-dependencies.json` were reviewed; upstream runtime
      security updates were considered. No unverified dependency is executed.
- [ ] Test install, refusal while running, upgrade and uninstall; confirm Pi user
      state remains untouched, and failed offline Pi seeding preserves the base app.
- [ ] Test the visible wizard and shortcuts on a clean Windows user profile;
      record any native/SmartScreen/antivirus checks not performed.

## Windows Setup and portable application ZIP

See [Windows Setup](windows-setup.md) for layout and build instructions.

- [ ] Use a clean Git worktree and a release tag matching package version and HEAD.
- [ ] Build into a unique temporary `PI_CHAT_DIST_DIR` with release mode enabled
      and the exact tag/revision. Record the staging path.
- [ ] `build-identity.json` package version, full SHA and fingerprint are correct.
- [ ] Package with `node scripts/release-package.mjs --staging <dist> --output <dir> --tag vX.Y.Z`.
- [ ] Setup packaging produces `pi-chat-setup.exe`, `.exe.sha256` and
      `.exe.manifest.json`. Separately package the portable app with
      `node scripts/portable-package.mjs --staging <dist> --output <dir> --tag vX.Y.Z`.
- [ ] The portable ZIP has forward-slash entries, the same version/revision as
      Setup, and launchers plus `server/`, `web/` at its extraction root. It does
      not bundle Node or Pi. No Web bootstrapper EXE is produced.
- [ ] The EXE embeds App + private Node/npm and their license/resource files.
      Installing these components does not download them.
- [ ] The schema-2 manifest identifies the Setup name/size/digest, embedded App
      revision/fingerprint, Node version/archive checksum and compiler version.
- [ ] Verify the checksum from the output directory; the record contains only the
      EXE basename, never a build-machine path.
- [ ] Packaging rejects live-dist aliases, overlapping staging/output directories,
      missing assets, dirty source and mismatching build/tag identity.
- [ ] Failed packaging removes stale EXE and sidecars; do not reuse previous ones.
- [ ] Existing Pi is preferred and not upgraded. Missing Pi is seeded offline
      from bundled Pi 1.3.0, including in silent mode; Setup never downloads Pi.
- [ ] With no Pi/network, App + Node install and bundled Pi is seeded. If seeding
      fails, the base app remains installed with a clear recovery message.
      No credentials are invented and no usable model is falsely claimed.
- [ ] A different running checkout is never stopped or taken over. Matching
      launch-plan identity and per-Session child/writer boundaries remain intact.
- [ ] Native uninstall refuses an active destination, removes only its own files,
      shortcuts and registration, and preserves `~/.pi/agent` and managed Pi.
- [ ] Build/transcript/credential state is not copied into distributable payloads.

## Publication

- [ ] Local source/artifact gates pass. Main pushes and PRs run lightweight
      Source Checks, not full CI or publication. For pre-release cloud
      verification, use manual Windows CI; all full checks remain required.
- [ ] Pushing a `v*` version tag automatically runs full Windows Release CI;
      publication waits for every gate, including installer verification.
- [ ] The GitHub Release contains exactly the verified Setup EXE and portable
      application ZIP. Checksum/manifest sidecars remain in CI artifacts only.
- [ ] Existing published tags/assets remain immutable by default; no `--clobber`
      uploads. A same-tag replacement requires explicit authorization, old/new
      revision records, and a complete rerun of Release CI, never a silent overwrite.
- [ ] Release notes describe both artifacts, bundled offline Pi, local-Node/Pi
      preference, platform/architecture, known limitations and unsigned status.
      GitHub source archives are source-only.
- [ ] README and Release body distinguish Stable, Preview and Main. A fix in main
      is not claimed to be in Stable until the artifact Build Revision confirms it.
- [ ] Historical v0.5.2 assets are not replaced by the new installer implementation.
