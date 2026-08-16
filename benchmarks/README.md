# Long-session and browser-fluency benchmark lanes

This directory is benchmark/test infrastructure only. It measures the current server-side Session reader/windowing helpers and the existing browser UI without changing production behavior.

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

It records action-to-settled-frame time, existing Pi Chat pane-commit time, DOM node count, renderer Long Tasks overlapping the action window, Chromium renderer JS heap, and load-earlier anchor error. A missing completion signal is an operational failure, not a performance sample.

Server-only fixtures cover artificially padded 10 MiB and 50 MiB size targets, a natural 1000-user-turn Session, a tool/process-heavy turn, Markdown/KaTeX-heavy content, image metadata, and encoded image content. The browser lane deliberately uses only the natural 1000-turn fixture: size-padding fixtures append artificial assistant payloads after the final user turn and would conflate JSONL size with giant visible-tail rendering.

Persisted fixture descriptors use stable logical names and content SHA-256 values, never deleted temporary paths. Server timings explicitly distinguish `SessionIndex` discovery/snapshot cache misses and hits; they do not claim OS-cold filesystem I/O.

The server JSON embeds the browser scenario contract. `run-browser-fluency-bench.mts` consumes that contract with generated fixtures and the disposable E2E fake-RPC server. Machine-readable results contain stable logical fixture names, content SHA-256 values, build identity, Chromium version, and viewport, but no temporary paths, URLs, ports, or user Session data.

Headless Chromium is a controlled comparison environment, not a claim about every installed Edge/PWA, GPU, or foreground scheduling configuration. Treat the numbers as evidence for selecting the next single-variable profiler experiment, not as release thresholds.
