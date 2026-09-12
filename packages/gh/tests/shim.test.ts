import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { join } from "node:path";
import { buildShim, createHarness, type Harness } from "./support/harness";

describe("the shim, at the process boundary (seam 1)", () => {
  let harness: Harness;

  beforeAll(() => {
    buildShim();
  });

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("forwards arguments, stdio and the exit code to the binary override", async () => {
    const stub = harness.stubGh({
      exitCode: 3,
      stderr: "stub: reporting on stderr",
    });
    const result = await harness.spawnShim(
      ["--version", "--flag", "value with spaces"],
      { env: { GH_BINARY: stub }, input: "piped stdin payload" }
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("stub: reporting on stderr");
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
    expect(report.args).toEqual(["--version", "--flag", "value with spaces"]);
    expect(report.stdin).toBe("piped stdin payload");
  });

  test("with the override set, makes no network requests and writes nothing to any cache location", async () => {
    const stub = harness.stubGh();
    const before = harness.sandbox.listTree();
    const result = await harness.spawnShim(["auth", "status"], {
      env: { GH_BINARY: stub },
    });

    expect(result.exitCode).toBe(0);
    expect(harness.mirror.requests).toHaveLength(0);
    expect(harness.sandbox.listTree()).toEqual(before);
  });

  test("without the override, fails cleanly with a hint pointing at GH_BINARY", async () => {
    const result = await harness.spawnShim(["--version"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("GH_BINARY");
  });

  test("with the override pointing at a missing executable, fails with exit code 1 and an error naming it", async () => {
    const missing = join(harness.sandbox.root, "no-such-binary");
    const result = await harness.spawnShim(["--version"], {
      env: { GH_BINARY: missing },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("GH_BINARY");
    expect(result.stderr).toContain(missing);
  });
});
