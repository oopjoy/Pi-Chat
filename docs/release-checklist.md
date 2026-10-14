# Release Checklist

Work from isolated staging. Never overwrite live dist, restart the current
service, or interrupt active Sessions without an authorized quiescent window.

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
      state remains untouched, and optional Pi failure preserves the base app.
- [ ] Test the visible wizard and shortcuts on a clean Windows user profile;
      record any native/SmartScreen/antivirus checks not performed.

## One Windows Setup

See [Windows Setup](windows-setup.md) for layout and build instructions.

- [ ] Use a clean Git worktree and a release tag matching package version and HEAD.
- [ ] Build into a unique temporary `PI_CHAT_DIST_DIR` with release mode enabled
      and the exact tag/revision. Record the staging path.
- [ ] `build-identity.json` package version, full SHA and fingerprint are correct.
- [ ] Package with `node scripts/release-package.mjs --staging <dist> --output <dir> --tag vX.Y.Z`.
- [ ] Output contains only `pi-chat-setup.exe`, `.exe.sha256` and
      `.exe.manifest.json`. No Web EXE or portable application ZIP is produced.
- [ ] The EXE embeds App + private Node/npm and their license/resource files.
      Installing these components does not download them.
- [ ] The schema-2 manifest identifies the Setup name/size/digest, embedded App
      revision/fingerprint, Node version/archive checksum and compiler version.
- [ ] Verify the checksum from the output directory; the record contains only the
      EXE basename, never a build-machine path.
- [ ] Packaging rejects live-dist aliases, overlapping staging/output directories,
      missing assets, dirty source and mismatching build/tag identity.
- [ ] Failed packaging removes stale EXE and sidecars; do not reuse previous ones.
- [ ] Existing Pi is preferred and not upgraded. Optional missing-Pi installation
      occurs only after explicit choice; silent setup does not download Pi.
- [ ] With no Pi/network, base App + Node still install. The app opens with a
      clear unavailable-Runtime state, not an apparently working model.
- [ ] A different running checkout is never stopped or taken over. Matching
      launch-plan identity and per-Session child/writer boundaries remain intact.
- [ ] Native uninstall refuses an active destination, removes only its own files,
      shortcuts and registration, and preserves `~/.pi/agent` and managed Pi.
- [ ] Build/transcript/credential state is not copied into distributable payloads.

## Publication

- [ ] Branch CI is green before creating a release tag.
- [ ] Tag Release CI publishes the exact verified Setup and two sidecars.
- [ ] Existing published tags/assets remain immutable; no `--clobber` uploads.
- [ ] Release notes describe one Setup, optional Pi networking, platform/architecture,
      known limitations and unsigned status. GitHub source archives are source-only.
- [ ] Historical v0.5.2 assets are not replaced by the new installer implementation.
