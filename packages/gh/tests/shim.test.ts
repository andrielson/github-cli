import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildShim,
  createHarness,
  wrapperVersion,
  type Harness,
  type SpawnResult,
} from "./support/harness";

/** The stub's report line: what the real binary received at the boundary. */
function reportOf(result: SpawnResult): { args: string[]; stdin: string } {
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
}

describe("the binary override, at the process boundary (seam 1)", () => {
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
    expect(reportOf(result).args).toEqual([
      "--version",
      "--flag",
      "value with spaces",
    ]);
    expect(reportOf(result).stdin).toBe("piped stdin payload");
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

describe("the lazy download, at the process boundary (seam 1)", () => {
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

  test("first run downloads, verifies, extracts, caches and re-executes the real binary", async () => {
    const release = harness.serveRelease({
      stub: { exitCode: 3, stderr: "stub: reporting on stderr" },
    });
    const result = await harness.spawnShim(
      ["--version", "--flag", "value with spaces"],
      { input: "piped stdin payload" }
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("stub: reporting on stderr");
    expect(reportOf(result).args).toEqual([
      "--version",
      "--flag",
      "value with spaces",
    ]);
    expect(reportOf(result).stdin).toBe("piped stdin payload");
    expect(existsSync(release.cacheBinaryPath)).toBe(true);
    expect(
      harness.mirror.requests.map((request) => request.path).sort()
    ).toEqual([release.assetPath, release.checksumsPath].sort());
  });

  test("second run is a cache hit: the mirror receives zero requests", async () => {
    const release = harness.serveRelease();
    expect((await harness.spawnShim(["--version"])).exitCode).toBe(0);
    const requestsAfterFirstRun = harness.mirror.requests.length;

    const result = await harness.spawnShim(["auth", "status"], {
      input: "cached stdin",
    });

    expect(result.exitCode).toBe(0);
    expect(reportOf(result).args).toEqual(["auth", "status"]);
    expect(reportOf(result).stdin).toBe("cached stdin");
    expect(harness.mirror.requests).toHaveLength(requestsAfterFirstRun);
    expect(existsSync(release.cacheBinaryPath)).toBe(true);
  });

  test("a tampered checksum aborts the install: nothing cached, the binary never executes", async () => {
    const release = harness.serveRelease({ tamperChecksum: true });
    const result = await harness.spawnShim(["--version"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("checksum");
    expect(result.stdout).toBe("");
    expect(existsSync(release.cacheBinaryPath)).toBe(false);
    expect(
      harness.sandbox.listTree().some((path) => path.includes("staging"))
    ).toBe(false);
  });

  test("a checksums file without an entry for the asset aborts fail-closed", async () => {
    const release = harness.serveRelease({ omitChecksumEntry: true });
    const result = await harness.spawnShim(["--version"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(release.assetName);
    expect(result.stdout).toBe("");
    expect(existsSync(release.cacheBinaryPath)).toBe(false);
  });

  test("locates the binary under the archive root dynamically, not by a hardcoded path", async () => {
    harness.serveRelease({ archiveRoot: "an-unexpected-root" });
    const result = await harness.spawnShim(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(reportOf(result).args).toEqual(["--version"]);
  });

  test("concurrent first runs race safely: both run, one cache entry, no staging leftovers", async () => {
    const release = harness.serveRelease();
    const [first, second] = await Promise.all([
      harness.spawnShim(["auth", "status"]),
      harness.spawnShim(["auth", "status"]),
    ]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(existsSync(release.cacheBinaryPath)).toBe(true);
    expect(
      harness.sandbox.listTree().some((path) => path.includes("staging"))
    ).toBe(false);
    // The cache entry is a working binary, not a torn one.
    const again = await harness.spawnShim(["--version"]);
    expect(again.exitCode).toBe(0);
  });

  test("an unsupported platform fails with an error listing manual install options", async () => {
    const result = await harness.spawnShim(["--version"], {
      env: { GH_PLATFORM: "sunos", GH_ARCH: "x64" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sunos");
    expect(result.stderr).toContain("https://github.com/cli/cli");
    expect(harness.mirror.requests).toHaveLength(0);
  });

  test("with nothing served at the mirror, fails cleanly naming what it tried to download", async () => {
    const result = await harness.spawnShim(["--version"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`v${wrapperVersion}`);
    expect(result.stderr).toContain(harness.mirror.url);
  });
});
