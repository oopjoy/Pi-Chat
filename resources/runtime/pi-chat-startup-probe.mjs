import { writeSync } from "node:fs";

const marker = (value) => {
  try { writeSync(3, `${value}\n`); }
  catch {
    // Startup diagnostics are fail-open and never participate in Runtime readiness.
  }
};

// Keep fd 3 open for the lifetime of this child. It is an inherited diagnostic
// pipe, not a data channel; the parent consumes only the closed marker alphabet.
marker("P");
setImmediate(() => marker("I"));
