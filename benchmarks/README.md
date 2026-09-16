# Long-session and browser-fluency benchmark lanes

This directory is benchmark/test infrastructure only. It measures the current server-side Session reader/windowing helpers and the existing browser UI without changing production behavior.

## React render evidence build

The Web UI has a maintenance-only React Profiler seam around keyed conversation items. It is disabled in ordinary builds and cannot be enabled against the repository live `dist`:

PowerShell example:

```powershell
$env:PI_CHAT_DIST_DIR = "C:\path\to\staging-dist"
$env:PI_CHAT_BENCHMARK_REACT_PROFILER = "1"
npm run build:identity
npm run build:web
```

The same variables can be exported in a POSIX shell. Build the staging Web artifact with those variables, then inspect `window.__piChatReactRenderBenchmark.commits` in Chromium or use it from a benchmark runner. Each record contains the item identity, React phase, `actualDuration`, `baseDuration`, and commit timestamps. This is evidence collection only; it does not add a production threshold or change Session, SSE, Pane, or scroll behavior.

## Safety

- Fixtures are generated on demand; no large JSONL files or result artifacts are committed.
- Both runners use fresh OS temporary directories and remove them in `finally` blocks.
- Neither runner reads the default Pi Session directory or starts port 30170.
- The server-only runner does not use `dist`. The browser runner requires an explicit read-only staging dist, rejects the repository `dist`, and never runs a build.
- Every browser iteration uses a disposable fake-RPC server on a loopback ephemeral port and a fresh Chromium context. Teardown confirms the server process tree exited.
- Results are descriptive baselines. There are deliberately no pass/fail thresholds.

## Commands

Generate one deterministic fixture (optionally pass `--minimum-bytes N`; generated content may intrinsically be larger):

```sh
node --import tsx benchmarks/generate-long-session-fixture.mts --scenario ordinary-10mib --output ./tmp/ordinary.jsonl
```

Run all server measurements and write machine-readable JSON:

```sh
node --import tsx benchmarks/run-long-session-bench.mts --iterations 3 --output ./tmp/long-session-benchmark.json
```

Run a focused, faster server scenario:

```sh
node --import tsx benchmarks/run-long-session-bench.mts --scenario thousand-user-turns --iterations 1 --output ./tmp/1000-turns.json
```

Record the $128$ MiB full-snapshot server-side Session baseline with a padded deterministic fixture. This uses a private OS-temporary directory; it does not read a personal Session or use `dist`:

```sh
node --import tsx benchmarks/run-long-session-bench.mts --scenario ordinary-50mib --minimum-bytes 134217728 --iterations 3 --output ./tmp/long-session-128mib.json
```

The full-snapshot runner deliberately rejects fixtures larger than the production $128$ MiB `MAX_SESSION_SNAPSHOT_BYTES` contract. Do not pass $256$ MiB or $512$ MiB targets to this command; use the bounded-tail lane below so the benchmark does not bypass the server's memory guard.

Measure a $256$ MiB or $512$ MiB Session through the production bounded recent-tail reader. The fixture puts a large deterministic history before a small recent suffix, and the runner verifies truncation, cumulative summary facts, exact persisted message identity, bounded bytes read, and four concurrent tail reads:

```sh
npm run benchmark:bounded-tail -- --minimum-bytes 268435456 --iterations 3 --output ./tmp/bounded-tail-256mib.json
npm run benchmark:bounded-tail -- --minimum-bytes 536870912 --iterations 3 --output ./tmp/bounded-tail-512mib.json
```

This lane intentionally does not call the full `snapshotForId()` path for oversized files. It exercises `SessionIndex.recentSnapshotForId()`, which is the production bounded-tail contract for cold large Sessions. Results are descriptive and do not establish pass/fail thresholds.

The result records the Node runner peak RSS in bytes and cache-miss/cache-hit timing separately. RSS is process-level evidence for the runner, not a claim of total Pi Chat or browser memory. Compare two like-for-like results only when their fixture byte counts match; comparison is descriptive and deliberately never exits nonzero for a timing regression:

```sh
node --import tsx benchmarks/compare-long-session-baselines.mts --baseline ./tmp/long-session-128mib-before.json --candidate ./tmp/long-session-128mib-after.json --output ./tmp/long-session-comparison.json
```

Run the real Chromium fluency lane against an already-built staging dist:

```sh
node --import tsx benchmarks/run-browser-fluency-bench.mts --dist C:/path/to/staging-dist --iterations 3 --output ./tmp/browser-fluency.json
```

Run the isolated streaming-cadence matrix. This command builds two private variants under a fresh OS-temporary root and never writes repository `dist`:

```sh
npm run benchmark:streaming-cadence -- --iterations 3 --output ./tmp/streaming-cadence.json
```

The streaming lane compares exactly three package policies: server `50 ms` plus browser timeout `50 ms`, server `33 ms` plus frame-aligned latest-snapshot commits, and server `25 ms` plus frame-aligned latest-snapshot commits. Each policy runs with one or four concurrent Sessions and plain or Markdown/KaTeX-heavy cumulative content. The four-Session case has one visible pane plus three offscreen cache streams; it is not four simultaneously painted panes. A deterministic `20 ms` fake-RPC source emits 60 cumulative snapshots from a shared future barrier. The runner records and gates actual source duration, interval distribution, lateness, and cross-process start skew rather than treating the requested source interval as observed truth.

Each sample attests the staged browser policy and entry-asset SHA-256, the effective server interval, exact per-Session source completion, worst-case timing/lateness across the selected sources, terminal browser receipt, offscreen-cache terminal availability, and healthy transport outcomes. The result also hashes the benchmark runner and matrix library so a retained artifact identifies the measurement harness that produced it. Markdown/KaTeX samples wait for fonts and require headings, tables, fenced code, KaTeX nodes, and no KaTeX errors. Browser metrics are explicitly frame-coalesced DOM observations and double-`requestAnimationFrame` opportunities; they are not physical-display telemetry or exact React commit timestamps. Frame gaps and Long Tasks begin at the visible `agent_start` window. Three default iterations rotate policy order with a deterministic Latin-square strategy. Comparison readiness requires at least one complete three-iteration cycle; one, four, or five iterations remain non-comparison-ready.

Results remain descriptive only with no thresholds. Successful JSON is emitted only after Chromium, owned process trees, and the temporary benchmark root have confirmed cleanup. Output paths inside live `dist`, including filesystem-link aliases, are rejected. Signal handling attempts the same owned cleanup and reports a retained root rather than claiming success if exit cannot be confirmed. The runner does not change the production default cadence.

The browser lane measures:

- `cold-first-pane`: generated natural 1000-turn JSONL to matching `cold-jsonl` pane commit plus two animation frames;
- `hot-switch`: return to the same natural recent pane through `browser-cache` in one browser context;
- `load-earlier`: expand that same generated 1000-turn Session and compare the viewport position of the same pre-existing user-message anchor.

It records action-to-settled-frame time, existing Pi Chat pane-commit time, DOM node count, renderer Long Tasks overlapping the action window, Chromium renderer JS heap, load-earlier anchor error, and optional maintenance-build React render evidence. React evidence is marked unsupported for ordinary production builds. A missing completion signal is an operational failure, not a performance sample.

Server-only fixtures cover artificially padded 10 MiB and 50 MiB size targets, a natural 1000-user-turn Session, a tool/process-heavy turn, Markdown/KaTeX-heavy content, image metadata, and encoded image content. The browser lane deliberately uses only the natural 1000-turn fixture: size-padding fixtures append artificial assistant payloads after the final user turn and would conflate JSONL size with giant visible-tail rendering.

Persisted fixture descriptors use stable logical names and content SHA-256 values, never deleted temporary paths. Server timings explicitly distinguish `SessionIndex` discovery/snapshot cache misses and hits; they do not claim OS-cold filesystem I/O.

The server JSON embeds the browser scenario contract. `run-browser-fluency-bench.mts` consumes that contract with generated fixtures and the disposable E2E fake-RPC server. Machine-readable results contain stable logical fixture names, content SHA-256 values, build identity, Chromium version, and viewport, but no temporary paths, URLs, ports, or user Session data.

Headless Chromium is a controlled comparison environment, not a claim about every installed Edge/PWA, GPU, or foreground scheduling configuration. Treat the numbers as evidence for selecting the next single-variable profiler experiment, not as release thresholds.
