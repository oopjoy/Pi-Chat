# Release Checklist

Run every item from a clean, isolated staging directory. Do not replace the live `dist/`, restart the live service, or operate the normal listener until an authorized deployment window and a quiescent Runtime state exist.

## Build And Tests

- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` completes; the initial rollout may report warnings while the existing debt is reduced.
- [ ] `npm run check:type-debt` passes without exceeding the committed baseline.
- [ ] Full unit validation passes with a unique absolute `PI_CHAT_DIST_DIR` under the OS temp directory.
- [ ] Complete Playwright passes with a different unique absolute `PI_CHAT_DIST_DIR` under the OS temp directory.
- [ ] Release staging paths are recorded; do not use the auto-cleaning contributor wrapper for the artifact that will be packaged.
- [ ] Build the release staging tree with `PI_CHAT_RELEASE_MODE=1`, `PI_CHAT_RELEASE_TAG=vX.Y.Z`, and a unique absolute `PI_CHAT_DIST_DIR`; release mode requires the checked-out `HEAD` to equal the tag target and writes the full commit SHA into `build-identity.json`.
- [ ] `git diff HEAD --check` passes before commit, `git show --check --format= HEAD` passes for the release commit, and `npm run check:committed-text` passes against committed text blobs.
- [ ] The staged `build-identity.json` has the intended package version, exact Git revision, and a non-`unknown` fingerprint.
- [ ] Run `node scripts/release-package.mjs --staging <staging-dist> --output <release-output> --tag vX.Y.Z`; keep the generated ZIP, portable `.sha256`, and `.manifest.json` together. Do not calculate a checksum by redirecting `sha256sum` without replacing its local path with the ZIP basename.

## Windows Package

- [ ] Build the ZIP from the verified staged artifact, never from live `dist/`; the release packaging command must reject live `dist/`, canonical aliases, and overlapping staging/output directories.
- [ ] Confirm the ZIP contains the root launchers, `resources/icons/pi-chat.ico`, `scripts/pi-chat-launch-process.ps1`, and `scripts/pi-chat-port-ready.ps1`; these launcher dependencies must also be included in the build fingerprint.
- [ ] Verify the generated checksum with `sha256sum -c <zip>.sha256` (or the Windows equivalent) from a directory containing the ZIP; the record must name only the portable ZIP basename.
- [ ] Inspect the ZIP's `dist/build-identity.json`; revision and fingerprint match the release commit and staged build.
- [ ] Inspect the generated `.manifest.json`; package version, tag, full revision, fingerprint, ZIP name, size, and SHA-256 must match the ZIP and embedded identity.
- [ ] If packaging fails, confirm stale ZIP, checksum, and manifest sidecars were removed; do not publish a previous sidecar as current evidence.
- [ ] Verify the staged server, Web assets, direct Pi RPC adapter, startup probe, minimal package identity, and all Windows launcher dependencies exist. `scripts/runtime-required-files.json` is the shared required-file list; both release packaging and Windows preflight call `scripts/check-runtime-files.mjs`. Packaging must fail before creating an archive if any listed file or HTML JS/CSS entry asset is missing or empty.
- [ ] Confirm the ZIP includes `scripts/pi-chat-preflight.ps1`, `scripts/pi-chat-start-server.ps1`, `scripts/check-runtime-files.mjs`, and `scripts/runtime-required-files.json`; no npm/source checkout is needed to launch a complete release.
- [ ] Verify missing/old Node and an unbuilt source checkout show actionable errors without downloading dependencies. Double-click CMD failures stay visible; automated callers use `PI_CHAT_NONINTERACTIVE=1`.
- [ ] Verify both npm and official managed Pi installs resolve through the server, and an invalid explicit `PI_CHAT_PI_ENTRY` never falls back to another install. A portable, source-free isolated startup fixture covers managed discovery with fake RPC.
- [ ] On the verified Pi version, confirm startup logs resolve the expected direct entry and that a child starts only through the local RPC adapter; missing or incompatible Pi must fail closed while JSONL browsing remains available.
- [ ] Confirm Primary and at least two Secondary Sessions have distinct child PIDs while sharing the same frozen launch plan; no shared SDK host, broker, or process rebinding is introduced.
- [ ] In a clean directory, launch the ZIP and verify its startup handshake identity matches the embedded Web bundle identity.
- [ ] Verify the listener on the selected port reports the expected build identity.
- [ ] Start a second package with another fingerprint and verify its launcher reports a conflict without requesting `/api/shutdown` or terminating the first instance.

## Publish

- [ ] Commit and tag point to the verified source revision.
- [ ] Windows Release CI publishes the exact ZIP, checksum, and manifest produced by its verified staging job; do not manually bridge a separately built ZIP into the public Release.
- [ ] The repository has a protected `refs/tags/v*` ruleset that rejects tag update/delete/force-move after publication.
- [ ] Source archive is described as source-only; the Windows ZIP is identified as the runnable package.
- [ ] Release notes include the ZIP checksum and known platform scope.
