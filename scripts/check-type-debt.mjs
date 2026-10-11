import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../src");
const limits = {
  explicitAny: 724,
  recordAny: 32,
  castAny: 37,
  proxy: 8,
};

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const files = await filesUnder(root);
const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
const counts = {
  explicitAny: (source.match(/: any\b/g) || []).length,
  recordAny: (source.match(/Record<string, any>/g) || []).length,
  castAny: (source.match(/as any\b/g) || []).length,
  proxy: (source.match(/new Proxy\(/g) || []).length,
};

console.log(JSON.stringify({ limits, counts }, null, 2));
const violations = Object.entries(limits)
  .filter(([name, limit]) => counts[name] > limit)
  .map(([name, limit]) => `${name}=${counts[name]} exceeds baseline ${limit}`);
if (violations.length) {
  console.error(`[Pi Chat] Type-debt baseline exceeded: ${violations.join(", ")}`);
  process.exitCode = 1;
}
