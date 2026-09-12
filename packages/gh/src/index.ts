import { spawn } from "node:child_process";

/** The binary override: a user-set pointer to an existing gh binary. */
const BINARY_OVERRIDE_ENV = "GH_BINARY";

function fail(message: string): void {
  process.stderr.write(`gh: ${message}\n`);
  process.exitCode = 1;
}

/**
 * Execute the override binary with the caller's arguments, wiring stdio
 * straight through, and mirror its exit. No download, no cache, no
 * verification: trust resides with the user who placed the binary.
 */
function runBinaryOverride(overridePath: string): void {
  const child = spawn(overridePath, process.argv.slice(2), {
    stdio: "inherit",
  });
  child.on("error", (error) => {
    fail(
      `could not execute the binary override ${BINARY_OVERRIDE_ENV}=${overridePath}: ${error.message}`
    );
  });
  child.on("close", (code, signal) => {
    // A failed spawn reports its libuv errno as a negative code (and null
    // signal); the error handler above already reported it and set exit 1.
    if (code !== null && code >= 0) {
      process.exitCode = code;
    } else if (signal !== null) {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exitCode = 1;
      }
    }
  });
}

function main(): void {
  const overridePath = process.env[BINARY_OVERRIDE_ENV];
  if (overridePath) {
    runBinaryOverride(overridePath);
    return;
  }
  fail(
    `no ${BINARY_OVERRIDE_ENV} is set and the lazy download is not implemented yet; ` +
      `point ${BINARY_OVERRIDE_ENV} at an existing gh binary`
  );
}

main();
