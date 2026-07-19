import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = resolve(root, "node_modules/katex/dist/katex.min.css");
const output = resolve(root, "src/web/generated/katex-woff2.css");
let css = await readFile(input, "utf8");
css = css.replace(/src:url\(([^)]+\.woff2)\) format\("woff2"\),url\([^)]+\.woff\) format\("woff"\),url\([^)]+\.ttf\) format\("truetype"\)/g, 'src:url($1) format("woff2")');
css = css.replaceAll("url(fonts/", "url(../../../node_modules/katex/dist/fonts/");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, css);
