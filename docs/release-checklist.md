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
- [ ] Verify `dist/resources/pi-runtime/manifest.json`, the RPC Bundle, image worker, CLI wrapper, minimal package identity, and Photon JS/WASM exist; the manifest must pin the recipe/esbuild version, enumerate every bundled source input, and hash every regular Runtime artifact.
- [ ] On the verified Pi version, confirm startup logs select the fingerprint-matched Bundle; corrupt/mismatch one staged hash and confirm startup falls back to the frozen direct entry before spawning a child.
- [ ] Confirm Primary and at least two Secondary Sessions have distinct child PIDs while sharing the same frozen launch plan; no shared SDK host, broker, or process rebinding is introduced.
- [ ] In a clean directory, launch the ZIP and verify its startup handshake identity matches the embedded Web bundle identity.
- [ ] Verify the listener on the selected port reports the expected build identity.
- [ ] Start a second package with another fingerprint and verify its launcher reports a conflict without requesting `/api/shutdown` or terminating the first instance.

## Publish

- [ ] Commit and tag point to the verified source revision.
- [ ] Source archive is described as source-only; the Windows ZIP is identified as the runnable package.
- [ ] Release notes include the ZIP checksum and known platform scope.
