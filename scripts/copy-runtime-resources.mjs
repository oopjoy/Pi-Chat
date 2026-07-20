import { cp, rm } from "node:fs/promises";

await rm("dist/resources", { recursive: true, force: true });
await cp("resources", "dist/resources", { recursive: true });
