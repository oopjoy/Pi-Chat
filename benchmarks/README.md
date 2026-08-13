# Long-session benchmark lane

This directory is benchmark/test infrastructure only. It imports the current server-side session reader and windowing helpers without changing production behavior.

## Safety

- Fixtures are generated on demand; no large JSONL files are committed.
- The runner uses fresh OS temporary directories and removes them in a `finally` block.
- It never reads the default Pi Session directory, starts port 30170, or reads/writes `dist`.
- Results are descriptive baselines. There are deliberately no pass/fail thresholds yet.

## Commands

Generate one deterministic fixture:

```sh
node --import tsx benchmarks/generate-long-session-fixture.mts --scenario ordinary-10mib --output ./tmp/ordinary.jsonl
```

Run all server measurements and write machine-readable JSON:

```sh
node --import tsx benchmarks/run-long-session-bench.mts --iterations 3 --output ./tmp/long-session-benchmark.json
```

Run a focused, faster scenario:

```sh
node --import tsx benchmarks/run-long-session-bench.mts --scenario thousand-user-turns --iterations 1 --output ./tmp/1000-turns.json
```

Supported fixtures cover ordinary 10 MiB and 50 MiB sessions, 1000 user turns, a tool/process-heavy turn, Markdown/KaTeX-heavy content, image metadata, and encoded image content.

The JSON result embeds a browser scenario contract for cold first pane, hot switch, and load-earlier measurements, including DOM count, long tasks, and heap. The contract intentionally does not start a browser or production server; a future isolated Chromium lane can consume it without depending on live user state.
