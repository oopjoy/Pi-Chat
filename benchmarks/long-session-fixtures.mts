import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const FIXTURE_SCENARIOS = [
  "ordinary-10mib",
  "ordinary-50mib",
  "thousand-user-turns",
  "tool-process-heavy",
  "markdown-katex-heavy",
  "image-metadata-heavy",
  "image-content-heavy",
] as const;

export type FixtureScenario = typeof FIXTURE_SCENARIOS[number];
type JsonRecord = Record<string, unknown>;

export interface FixtureOptions {
  scenario: FixtureScenario;
  outputPath: string;
  targetBytes?: number;
}

export interface FixtureManifest {
  schemaVersion: 1;
  scenario: FixtureScenario;
  path: string;
  bytes: number;
  targetBytes: number | null;
  sessionId: string;
  records: number;
  messages: number;
  userTurns: number;
  toolCalls: number;
  imageBlocks: number;
  sha256Seed: string;
}

const MIB = 1024 * 1024;
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const DEFAULT_TARGETS: Partial<Record<FixtureScenario, number>> = {
  "ordinary-10mib": 10 * MIB,
  "ordinary-50mib": 50 * MIB,
  "tool-process-heavy": 4 * MIB,
  "markdown-katex-heavy": 4 * MIB,
  "image-metadata-heavy": 2 * MIB,
  "image-content-heavy": 8 * MIB,
};

interface FixtureShape {
  records: JsonRecord[];
  messages: number;
  userTurns: number;
  toolCalls: number;
  imageBlocks: number;
  leafId: string;
}

function timestamp(index: number): string {
  return new Date(BASE_TIME + index * 1_000).toISOString();
}

function message(id: string, parentId: string | null, role: string, content: unknown, index: number, extra: JsonRecord = {}): JsonRecord {
  return {
    type: "message",
    id,
    parentId,
    timestamp: timestamp(index),
    message: { role, content, timestamp: BASE_TIME + index * 1_000, ...extra },
  };
}

function header(scenario: FixtureScenario): JsonRecord[] {
  return [
    { type: "session", version: 3, id: `bench-${scenario}`, timestamp: timestamp(0), cwd: resolve("benchmarks", "fixture-workspace") },
    { type: "session_info", id: "info-000000", parentId: null, name: `Long Session Benchmark: ${scenario}` },
    { type: "model_change", id: "model-000000", parentId: "info-000000", provider: "benchmark-provider", modelId: "deterministic-model" },
    { type: "thinking_level_change", id: "thinking-000000", parentId: "model-000000", thinkingLevel: "medium" },
  ];
}

function ordinaryShape(scenario: FixtureScenario, turns = 200): FixtureShape {
  const records = header(scenario);
  let parentId = "thinking-000000";
  for (let turn = 0; turn < turns; turn += 1) {
    const suffix = String(turn).padStart(6, "0");
    const userId = `user-${suffix}`;
    const assistantId = `assistant-${suffix}`;
    records.push(message(userId, parentId, "user", [{ type: "text", text: `Deterministic benchmark question ${turn}: summarize item ${turn % 17}.` }], turn * 2 + 1));
    records.push(message(assistantId, userId, "assistant", [{ type: "text", text: `Deterministic ordinary response ${turn}. ` + "alpha beta gamma delta ".repeat(8) }], turn * 2 + 2, {
      provider: "benchmark-provider",
      model: "deterministic-model",
      stopReason: "stop",
      usage: { input: 100 + turn, output: 40, cacheRead: turn * 3, cacheWrite: 0 },
    }));
    parentId = assistantId;
  }
  return { records, messages: turns * 2, userTurns: turns, toolCalls: 0, imageBlocks: 0, leafId: parentId };
}

function toolHeavyShape(): FixtureShape {
  const records = header("tool-process-heavy");
  const userId = "user-tool-heavy";
  records.push(message(userId, "thinking-000000", "user", "Inspect a large deterministic process trace.", 1));
  let parentId = userId;
  const toolCalls = 240;
  for (let index = 0; index < toolCalls; index += 1) {
    const suffix = String(index).padStart(6, "0");
    const callId = `call-${suffix}`;
    const assistantId = `assistant-tool-${suffix}`;
    const resultId = `result-${suffix}`;
    records.push(message(assistantId, parentId, "assistant", [
      { type: "thinking", thinking: `Deterministic tool planning step ${index}.` },
      { type: "toolCall", id: callId, name: index % 2 ? "read" : "bash", arguments: { path: `src/file-${index % 31}.ts`, command: `printf ${index}` } },
    ], index * 2 + 2));
    records.push(message(resultId, assistantId, "toolResult", [{ type: "text", text: `tool result ${index}\n` + "output-line deterministic value\n".repeat(24) }], index * 2 + 3, {
      toolCallId: callId,
      toolName: index % 2 ? "read" : "bash",
      isError: index % 29 === 0,
    }));
    parentId = resultId;
  }
  records.push(message("assistant-tool-final", parentId, "assistant", "The deterministic tool-heavy process is complete.", 600, {
    provider: "benchmark-provider", model: "deterministic-model", stopReason: "stop",
    usage: { input: 20_000, output: 4_000, cacheRead: 0, cacheWrite: 0 },
  }));
  return { records, messages: toolCalls * 2 + 2, userTurns: 1, toolCalls, imageBlocks: 0, leafId: "assistant-tool-final" };
}

function markdownKatexShape(): FixtureShape {
  const records = header("markdown-katex-heavy");
  let parentId = "thinking-000000";
  const turns = 80;
  const markdown = [
    "## Deterministic derivation",
    "",
    "| term | value |",
    "| --- | ---: |",
    "| alpha | 1 |",
    "| beta | 2 |",
    "",
    "Inline math: $E = mc^2$ and $a_n = a_1 + (n-1)d$.",
    "",
    "$$",
    String.raw`\sum_{k=1}^{n} k = \frac{n(n+1)}{2}`,
    "$$",
    "",
    "```ts",
    "const deterministic = (n: number) => n * (n + 1) / 2;",
    "```",
    "",
    "> A stable benchmark quotation with **bold**, _emphasis_, and [link](https://example.invalid).",
  ].join("\n");
  for (let turn = 0; turn < turns; turn += 1) {
    const suffix = String(turn).padStart(6, "0");
    const userId = `md-user-${suffix}`;
    const assistantId = `md-assistant-${suffix}`;
    records.push(message(userId, parentId, "user", `Render Markdown and math sample ${turn}.`, turn * 2 + 1));
    records.push(message(assistantId, userId, "assistant", [{ type: "text", text: `${markdown}\n\nSection ${turn}\n\n` + markdown.repeat(3) }], turn * 2 + 2));
    parentId = assistantId;
  }
  return { records, messages: turns * 2, userTurns: turns, toolCalls: 0, imageBlocks: 0, leafId: parentId };
}

function imageShape(scenario: "image-metadata-heavy" | "image-content-heavy"): FixtureShape {
  const records = header(scenario);
  let parentId = "thinking-000000";
  const turns = scenario === "image-content-heavy" ? 12 : 120;
  const imagesPerTurn = scenario === "image-content-heavy" ? 2 : 8;
  const encoded = scenario === "image-content-heavy" ? "QUJD".repeat(16_384) : "QUJD";
  for (let turn = 0; turn < turns; turn += 1) {
    const suffix = String(turn).padStart(6, "0");
    const userId = `image-user-${suffix}`;
    const assistantId = `image-assistant-${suffix}`;
    const content: JsonRecord[] = [{ type: "text", text: `Analyze deterministic image batch ${turn}.` }];
    for (let image = 0; image < imagesPerTurn; image += 1) {
      content.push({
        type: "image",
        mimeType: image % 2 ? "image/jpeg" : "image/png",
        data: encoded,
        width: 640 + image,
        height: 480 + turn,
        name: `fixture-${turn}-${image}.${image % 2 ? "jpg" : "png"}`,
      });
    }
    records.push(message(userId, parentId, "user", content, turn * 2 + 1));
    records.push(message(assistantId, userId, "assistant", `Recorded ${imagesPerTurn} deterministic image blocks for turn ${turn}.`, turn * 2 + 2));
    parentId = assistantId;
  }
  return { records, messages: turns * 2, userTurns: turns, toolCalls: 0, imageBlocks: turns * imagesPerTurn, leafId: parentId };
}

function shapeFor(scenario: FixtureScenario): FixtureShape {
  if (scenario === "thousand-user-turns") return ordinaryShape(scenario, 1_000);
  if (scenario === "tool-process-heavy") return toolHeavyShape();
  if (scenario === "markdown-katex-heavy") return markdownKatexShape();
  if (scenario === "image-metadata-heavy" || scenario === "image-content-heavy") return imageShape(scenario);
  return ordinaryShape(scenario);
}

function encoded(record: JsonRecord): string {
  return `${JSON.stringify(record)}\n`;
}

async function appendPadding(path: string, leafId: string, targetBytes: number, startIndex: number): Promise<{ records: number; messages: number }> {
  const file = await open(path, "a");
  let current = (await file.stat()).size;
  let records = 0;
  let messages = 0;
  try {
    while (current < targetBytes) {
      const remaining = targetBytes - current;
      const id = `padding-${String(startIndex + records).padStart(8, "0")}`;
      const emptyLine = encoded(message(id, leafId, "assistant", "", startIndex + records));
      const fixedBytes = Buffer.byteLength(emptyLine) - 2;
      const payloadBytes = Math.max(1, Math.min(256 * 1024, remaining - fixedBytes));
      if (remaining <= fixedBytes) break;
      const line = encoded(message(id, leafId, "assistant", "p".repeat(payloadBytes), startIndex + records));
      await file.write(line);
      current += Buffer.byteLength(line);
      records += 1;
      messages += 1;
      leafId = id;
    }
  } finally {
    await file.close();
  }
  return { records, messages };
}

export async function generateFixture(options: FixtureOptions): Promise<FixtureManifest> {
  if (!FIXTURE_SCENARIOS.includes(options.scenario)) throw new Error(`Unknown fixture scenario: ${options.scenario}`);
  const outputPath = resolve(options.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const shape = shapeFor(options.scenario);
  const targetBytes = options.targetBytes ?? DEFAULT_TARGETS[options.scenario] ?? null;
  const file = await open(outputPath, "w");
  try {
    for (const record of shape.records) await file.write(encoded(record));
  } finally {
    await file.close();
  }
  let padding = { records: 0, messages: 0 };
  if (targetBytes) padding = await appendPadding(outputPath, shape.leafId, targetBytes, shape.records.length + 1);
  const bytes = (await stat(outputPath)).size;
  return {
    schemaVersion: 1,
    scenario: options.scenario,
    path: outputPath,
    bytes,
    targetBytes,
    sessionId: `bench-${options.scenario}`,
    records: shape.records.length + padding.records,
    messages: shape.messages + padding.messages,
    userTurns: shape.userTurns,
    toolCalls: shape.toolCalls,
    imageBlocks: shape.imageBlocks,
    sha256Seed: createHash("sha256").update(`${options.scenario}:2026-01-01:v1`).digest("hex"),
  };
}

export async function validateFixture(path: string): Promise<{ records: number; sessionHeaders: number; invalidLines: number }> {
  const text = await readFile(path, "utf8");
  let records = 0;
  let sessionHeaders = 0;
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as JsonRecord;
      records += 1;
      if (record.type === "session" && typeof record.id === "string" && typeof record.cwd === "string") sessionHeaders += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { records, sessionHeaders, invalidLines };
}
