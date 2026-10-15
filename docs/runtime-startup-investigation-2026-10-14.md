# Runtime startup investigation — 2026-10-14

## Observed incident (read-only)

The running Git checkout still served revision `426a8a4`. The affected persisted
Session was “kimi代码审查”. Incident span `PS-IUF8HDF3` recorded:

| Observation | Elapsed from spawn invocation |
|---|---:|
| Spawn returned | 766 ms |
| Child pre-entry marker | 824 ms |
| Early event-loop marker (`child-entry-evaluated`) | 41,686 ms |
| Extension import ordinal 7 completed | 57,072 ms |
| Last recorded extension factory work completed | 64,781 ms |
| First stdout | 65,241 ms |
| First get_state response / transport ready | 65,412 ms |

The early event-loop marker is a `setImmediate` observation, **not proof that all
entry modules have finished evaluating**. The first large interval includes
module loading/initialization but does not by itself identify one slow module.

Current package resolution, inspected without loading extension factories or
installing/updating packages, maps ordinal 7 to `pi-subagents`. Its import took
14,091 ms in this span, versus 510 ms in the next persisted-Session start. The
next Runtime (“chat111”) became transport-ready in 8,788 ms. These are different
Sessions, not a controlled profile benchmark. No extension was disabled.

A later read-only Session view showed an assistant response after the user
message, no pending prompt and an empty queue. We did not resend the message,
stop a Runtime, restart the live server or modify user JSONL/configuration.

## Isolated comparison

Fresh processes used an empty temporary agent directory and workspace, all user
extensions/skills/context disabled, a single get_state, and no provider request.
The live 30170 service identity was checked before and after and stayed unchanged.

An initial run showed 30,898 ms for the existing async adapter and 1,717 ms for
plain direct RPC; private Node + async adapter took 19,118 ms. **The order and OS
cache state are confounded, so those numbers are not an optimization ratio.**

After switching the selective process-local adapter to Node's synchronous load
hook, alternating warm-file-cache measurements were:

| Runtime | Synchronous adapter | Original async adapter |
|---|---:|---:|
| System Node 24.16.0, pair 1 | 1,306 ms | 1,967 ms |
| System Node 24.16.0, pair 2 | 1,281 ms | 1,967 ms |
| Bundled Node 22.19.0 | 1,596 ms | 1,864 ms |

The improvement removes per-module loader-thread round trips. It does not skip
Pi initialization, extension imports/factories, capability checks, or prompt
persistence. The same three exact-source adapters remain in use: native dequeue,
canonical prompt receipt, and extension-startup timing. Unknown receipt/source
shapes retain the previous handling. An older-Node compatibility fallback keeps
the original async loader.

Both hook paths are compared byte-for-byte in regression tests against the
installed Pi source and the pinned development Pi. Real isolated Pi tests check
state, dequeue and extension phase telemetry. No global Pi file is patched.

## Remaining uncertainty

- This proves a fixed overhead reduction, **not elimination of the 65-second
  cold-start case**. No true OS-cold/Defender-cold experiment was performed.
- Observed paging during later inspection is not historical proof of the incident
  cause. Do not blame Defender or recommend disabling security software.
- Existing user extensions remain enabled in normal use. No model-provider
  request or arbitrary extension factory was run for the comparison.
- A new build must be deployed in a user-approved quiescent window before its
  startup time can be compared against future real Sessions. The long-term Git
  service and its live dist are not replaced by these tests.
