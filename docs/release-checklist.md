# Release Checklist

Run every item from a clean, isolated staging directory. Do not replace the live `dist/`, restart the live service, or operate the normal listener until an authorized deployment window and a quiescent Runtime state exist.

## Build And Tests

- [ ] `npm run typecheck` passes.
- [ ] Full unit validation passes with a unique absolute `PI_CHAT_DIST_DIR` under the OS temp directory.
- [ ] Complete Playwright passes with a different unique absolute `PI_CHAT_DIST_DIR` under the OS temp directory.
- [ ] Release staging paths and `PI_CHAT_BUILD_REVISION` are recorded; do not use the auto-cleaning contributor wrapper for the artifact that will be packaged.
- [ ] `git diff HEAD --check` passes before commit, and `git show --check --format= HEAD` passes for the release commit.
- [ ] The staged `build-identity.json` has the intended package version, exact Git revision, and a non-`unknown` fingerprint.

## Windows Package

- [ ] Build the ZIP from the verified staged artifact, never from live `dist/`.
- [ ] Calculate and publish the ZIP SHA-256 checksum.
- [ ] Inspect the ZIP's `dist/build-identity.json`; revision and fingerprint match the release commit and staged build.
- [ ] In a clean directory, launch the ZIP and verify its startup handshake identity matches the embedded Web bundle identity.
- [ ] Verify the listener on the selected port reports the expected build identity.
- [ ] Start a second package with another fingerprint and verify its launcher reports a conflict without requesting `/api/shutdown` or terminating the first instance.

## Publish

- [ ] Commit and tag point to the verified source revision.
- [ ] Source archive is described as source-only; the Windows ZIP is identified as the runnable package.
- [ ] Release notes include the ZIP checksum and known platform scope.
