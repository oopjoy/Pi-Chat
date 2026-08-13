import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FIXTURE_SCENARIOS, generateFixture, type FixtureScenario } from "./long-session-fixtures.mjs";

function usage(): never {
  console.error("Usage: node --import tsx benchmarks/generate-long-session-fixture.mts --scenario NAME --output PATH [--minimum-bytes N]");
  console.error(`Scenarios: ${FIXTURE_SCENARIOS.join(", ")}`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let scenario: FixtureScenario | undefined;
  let outputPath = "";
  let minimumBytes: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--scenario") scenario = args[++index] as FixtureScenario;
    else if (args[index] === "--output") outputPath = args[++index];
    else if (args[index] === "--minimum-bytes") minimumBytes = Number(args[++index]);
    else usage();
  }
  if (!scenario || !FIXTURE_SCENARIOS.includes(scenario) || !outputPath) usage();
  if (minimumBytes !== undefined && (!Number.isFinite(minimumBytes) || minimumBytes < 1)) usage();
  console.log(JSON.stringify(await generateFixture({ scenario, outputPath, minimumBytes }), null, 2));
}
