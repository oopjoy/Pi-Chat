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

## Follow-up — 2026-10-15

### Corrections to exploratory measurements

One uncontrolled extra process using the real agent directory reported 49,327 ms
until `get_state`. It inherited the caller's environment and real configuration,
without a phase trace or offline isolation. This demonstrates another slow sample,
**not that extension imports caused it**. No attribution to a package is justified.

A later experiment read 5.9 GB of unrelated data, then read the entire copied Pi
tree, then launched Pi. That last tree read prewarmed the measured files. Its
1,270 ms launch is **not an OS-cold result** and cannot rule out cache pressure.
File-tree copies also warm data and may trigger scanning on write. Tree file counts,
last-access timestamps, and sequential read latency do not establish how many files
Pi loads, nor distinguish Defender from filesystem/CPU/scheduling costs. No more
cache-pressure experiments are needed on this live workstation.

### Bounded isolated measurements

Temporary HOME/USERPROFILE, agent and workspace directories were used; no auth
files were copied. Network connects and subprocess creation were blocked for the
extension import/factory probes. Those probes are deliberately not equivalent to a
normal installed-profile startup.

| Experiment | Observed elapsed | Endpoint / limitation |
|---|---:|---|
| Import-only, 17 configured package/local entrypoints | 2,082 ms | Pi's Jiti import path; factories not called |
| `pi-subagents` within that pass | 388 ms | Warm-process/file-cache conditions, not cold attribution |
| Temporary profile with explicit extensions and factories, run 1 | 2,135 ms | Before `runRpcMode`; no `session_start` or broker connections |
| Same factory probe, run 2 | 2,189 ms | Same restricted endpoint |
| Official core benchmark, three fresh children | 1,224–1,258 ms | Isolated offline 193-byte synthetic Session; capability-ready |

The native factory timings in the restricted probe therefore cannot explain the
49-second real-profile sample by themselves. Real settings, resource discovery,
model setup, lifecycle hooks, and cache/load conditions remain different. Existing
live diagnostics also include a later real extension-bearing start (`PS-RIB5SWLU`)
at 3,005 ms, with maximum single import 400 ms and factory 584 ms. That is further
variability evidence, not a controlled comparison to the 65-second incident.

### Improve evidence for the next slow startup

The process-local adapter now emits three fixed markers on the existing diagnostic
pipe, with no extension names, paths, credentials, or message content:

| Incident phase | Boundary |
|---|---|
| `child-cli-parsed` | Pi finished the initial argument parsing checkpoint |
| `runtime-initialization-start` | Immediately before creating the agent-session Runtime |
| `runtime-initialization-end` | Runtime creation returned, before RPC binding/session-start completes |

Together with existing import/factory markers and `transport-ready`, these split
entry/bootstrap work from Runtime initialization and the subsequent RPC/lifecycle
wait. The old `child-entry-evaluated` name is retained for compatibility, but its
`setImmediate` meaning has not changed. All durations remain parent-observed wall
clock; a busy parent can delay reading the diagnostic pipe.

The new patch is idempotent and diagnostic-only. If Pi's exact checkpoint shape
changes or telemetry throws, normal execution continues. Unknown markers are
ignored and each new milestone is recorded at most once per child.

The existing benchmark now uses the production `rpcRegister` (previously omitted,
so import/factory instrumentation was absent). Its default `core` profile isolates
configuration and is offline. `installed-profile` remains an explicit, warned
opt-in that runs real extensions/settings. Neither profile claims OS-cold cache.
Cleanup retains the temporary tree if child exit cannot be confirmed.

```sh
npm run benchmark:pi-runtime-startup -- --session <offline-snapshot.jsonl> --iterations 3 --profile core
```

### Remaining work / deployment boundary

The 65-second case is **not closed**. On the next user-approved application update,
observe a real cold Session start using the additional milestones, without
resending prompts or forcibly warming every viewed Session. If a post-reboot
comparison is desired, run the benchmark before tree scans/copies and label the
first sample separately; reboot still does not guarantee a Defender-cold cache.
No extension was removed, no global Pi source patched, no security setting changed,
and no live service restarted by this follow-up.
