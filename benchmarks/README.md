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

The browser lane measures:

- `cold-first-pane`: generated natural 1000-turn JSONL to matching `cold-jsonl` pane commit plus two animation frames;
- `hot-switch`: return to the same natural recent pane through `browser-cache` in one browser context;
- `load-earlier`: expand that same generated 1000-turn Session and compare the viewport position of the same pre-existing user-message anchor.

It records action-to-settled-frame time, existing Pi Chat pane-commit time, DOM node count, renderer Long Tasks overlapping the action window, Chromium renderer JS heap, and load-earlier anchor error. A missing completion signal is an operational failure, not a performance sample.

Server-only fixtures cover artificially padded 10 MiB and 50 MiB size targets, a natural 1000-user-turn Session, a tool/process-heavy turn, Markdown/KaTeX-heavy content, image metadata, and encoded image content. The browser lane deliberately uses only the natural 1000-turn fixture: size-padding fixtures append artificial assistant payloads after the final user turn and would conflate JSONL size with giant visible-tail rendering.

Persisted fixture descriptors use stable logical names and content SHA-256 values, never deleted temporary paths. Server timings explicitly distinguish `SessionIndex` discovery/snapshot cache misses and hits; they do not claim OS-cold filesystem I/O.

The server JSON embeds the browser scenario contract. `run-browser-fluency-bench.mts` consumes that contract with generated fixtures and the disposable E2E fake-RPC server. Machine-readable results contain stable logical fixture names, content SHA-256 values, build identity, Chromium version, and viewport, but no temporary paths, URLs, ports, or user Session data.

Headless Chromium is a controlled comparison environment, not a claim about every installed Edge/PWA, GPU, or foreground scheduling configuration. Treat the numbers as evidence for selecting the next single-variable profiler experiment, not as release thresholds.
