import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["--test", "--import", "tsx", "tests/*.test.ts"], {
  env: { ...process.env, NODE_ENV: "test" },
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Test runner exited from signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
