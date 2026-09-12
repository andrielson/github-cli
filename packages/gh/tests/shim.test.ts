import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildShim,
  createHarness,
  startStubProxy,
  wrapperVersion,
  type Harness,
  type SpawnResult,
  type StubProxy,
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

  test("a failed download during any command aborts with a recovery hint naming gh install", async () => {
    const result = await harness.spawnShim(["auth", "status"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(harness.mirror.url);
    expect(result.stderr).toContain("gh install");
  });
});

describe("the install command, at the process boundary (seam 1)", () => {
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

  test("on a clean cache, downloads, verifies and populates the cache, then exits without running the binary", async () => {
    const release = harness.serveRelease({
      stub: { exitCode: 3, stderr: "stub: reporting on stderr" },
    });
    const result = await harness.spawnShim(["install"]);

    expect(result.exitCode).toBe(0);
    // The stub binary never ran: no report line on stdout, no marker on stderr.
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("stub: reporting on stderr");
    expect(existsSync(release.cacheBinaryPath)).toBe(true);
    expect(
      harness.mirror.requests.map((request) => request.path).sort()
    ).toEqual([release.assetPath, release.checksumsPath].sort());
  });

  test("re-run with a populated cache is a fast no-op: zero new mirror requests", async () => {
    harness.serveRelease();
    expect((await harness.spawnShim(["install"])).exitCode).toBe(0);
    const requestsAfterPrefetch = harness.mirror.requests.length;

    const result = await harness.spawnShim(["install"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(harness.mirror.requests).toHaveLength(requestsAfterPrefetch);
  });

  test("after the lazy path already populated the cache, gh install is a no-op", async () => {
    const release = harness.serveRelease();
    expect((await harness.spawnShim(["--version"])).exitCode).toBe(0);
    const requestsAfterFirstRun = harness.mirror.requests.length;

    const result = await harness.spawnShim(["install"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(harness.mirror.requests).toHaveLength(requestsAfterFirstRun);
    expect(existsSync(release.cacheBinaryPath)).toBe(true);
  });

  test("the ADR 0001 CI pattern: prefetch, then a version check with the mirror unreachable", async () => {
    const release = harness.serveRelease();
    const prefetch = await harness.spawnShim(["install"]);
    expect(prefetch.exitCode).toBe(0);
    // The prefetch must succeed on its own, without running the binary.
    expect(prefetch.stdout).toBe("");

    await harness.mirror.stop();
    const versionCheck = await harness.spawnShim(["--version"]);

    expect(versionCheck.exitCode).toBe(0);
    expect(reportOf(versionCheck).args).toEqual(["--version"]);
    expect(existsSync(release.cacheBinaryPath)).toBe(true);
  });

  test("with the binary override set, gh install is a no-op: no network, nothing written", async () => {
    const stub = harness.stubGh();
    const before = harness.sandbox.listTree();
    const result = await harness.spawnShim(["install"], {
      env: { GH_BINARY: stub },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("GH_BINARY");
    expect(result.stdout).toBe("");
    expect(harness.mirror.requests).toHaveLength(0);
    expect(harness.sandbox.listTree()).toEqual(before);
  });

  test("fails closed on a tampered checksum: exit 1, nothing cached, binary never runs", async () => {
    const release = harness.serveRelease({ tamperChecksum: true });
    const result = await harness.spawnShim(["install"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("checksum");
    expect(result.stdout).toBe("");
    expect(existsSync(release.cacheBinaryPath)).toBe(false);
  });

  test("on an unsupported platform, fails listing manual install options without touching the network", async () => {
    const result = await harness.spawnShim(["install"], {
      env: { GH_PLATFORM: "sunos", GH_ARCH: "x64" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sunos");
    expect(result.stderr).toContain("https://github.com/cli/cli");
    expect(harness.mirror.requests).toHaveLength(0);
  });
});

describe("proxy support on the download path, at the process boundary (seam 1)", () => {
  let harness: Harness;
  const proxies: StubProxy[] = [];

  beforeAll(() => {
    buildShim();
  });

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
    for (const proxy of proxies) {
      await proxy.stop();
    }
    proxies.length = 0;
  });

  /**
   * The upstream authority each proxied download was sent to: the runtime's
   * proxy dispatcher chooses the wire form — newer Node sends absolute-form
   * requests (the full URL as the request target), Node 22 CONNECT-tunnels
   * (the authority only). Either form is the wrapper keeping its promise
   * that the download travelled through the proxy; what travelled is proven
   * mirror-side.
   */
  function proxiedAuthorities(proxy: StubProxy): string[] {
    return proxy.requests.map((request) =>
      request.target.includes("://")
        ? new URL(request.target).host
        : request.target
    );
  }

  /** Serve a release and point a stub proxy at the mirror, in one step. */
  async function serveReleaseBehindProxy(
    stub: { exitCode?: number; stderr?: string } = {}
  ): Promise<{
    proxy: StubProxy;
    assetUrl: string;
    checksumsUrl: string;
    assetPath: string;
    checksumsPath: string;
    cacheBinaryPath: string;
  }> {
    const release = harness.serveRelease({ stub });
    const proxy = await startStubProxy(harness.mirror.url);
    proxies.push(proxy);
    return {
      proxy,
      assetUrl: `${harness.mirror.url}${release.assetPath}`,
      checksumsUrl: `${harness.mirror.url}${release.checksumsPath}`,
      assetPath: release.assetPath,
      checksumsPath: release.checksumsPath,
      cacheBinaryPath: release.cacheBinaryPath,
    };
  }

  test("a configured proxy routes both release downloads through it and the run still succeeds", async () => {
    const {
      proxy,
      assetUrl,
      checksumsUrl,
      assetPath,
      checksumsPath,
      cacheBinaryPath,
    } = await serveReleaseBehindProxy({
      exitCode: 3,
      stderr: "stub: reporting on stderr",
    });
    const result = await harness.spawnShim(
      ["--version", "--flag", "value with spaces"],
      { env: { http_proxy: proxy.url } }
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("stub: reporting on stderr");
    expect(reportOf(result).args).toEqual([
      "--version",
      "--flag",
      "value with spaces",
    ]);
    expect(existsSync(cacheBinaryPath)).toBe(true);
    // Both files travelled through the proxy — absolute-form requests or
    // CONNECT tunnels, whichever wire form the runtime's dispatcher chose —
    // and the proxy actually forwarded them: the mirror saw both too.
    expect(proxiedAuthorities(proxy).sort()).toEqual(
      [new URL(assetUrl).host, new URL(checksumsUrl).host].sort()
    );
    expect(
      harness.mirror.requests.map((request) => request.path).sort()
    ).toEqual([assetPath, checksumsPath].sort());
  });

  test("no_proxy excluding the download host bypasses the proxy entirely", async () => {
    const { proxy, assetPath, checksumsPath, cacheBinaryPath } =
      await serveReleaseBehindProxy();
    const result = await harness.spawnShim(["--version"], {
      env: { http_proxy: proxy.url, no_proxy: "127.0.0.1" },
    });

    expect(result.exitCode).toBe(0);
    expect(proxy.requests).toHaveLength(0);
    expect(
      harness.mirror.requests.map((request) => request.path).sort()
    ).toEqual([assetPath, checksumsPath].sort());
    expect(existsSync(cacheBinaryPath)).toBe(true);
  });

  test("no_proxy excluding the download host also bypasses an npm-configured proxy", async () => {
    const { proxy, assetPath, checksumsPath } = await serveReleaseBehindProxy();
    writeFileSync(join(harness.sandbox.home, ".npmrc"), `proxy=${proxy.url}\n`);
    const result = await harness.spawnShim(["--version"], {
      env: { no_proxy: "127.0.0.1" },
    });

    expect(result.exitCode).toBe(0);
    expect(proxy.requests).toHaveLength(0);
    expect(
      harness.mirror.requests.map((request) => request.path).sort()
    ).toEqual([assetPath, checksumsPath].sort());
  });

  test("no_proxy naming an unrelated host does not bypass the proxy", async () => {
    const { proxy } = await serveReleaseBehindProxy();
    const result = await harness.spawnShim(["--version"], {
      env: { http_proxy: proxy.url, no_proxy: "example.com" },
    });

    expect(result.exitCode).toBe(0);
    expect(proxy.requests).toHaveLength(2);
  });

  test("https_proxy does not capture plain-http downloads: protocol-specific matching", async () => {
    const { proxy, assetPath, checksumsPath } = await serveReleaseBehindProxy();
    const result = await harness.spawnShim(["--version"], {
      env: { https_proxy: proxy.url },
    });

    expect(result.exitCode).toBe(0);
    expect(proxy.requests).toHaveLength(0);
    expect(
      harness.mirror.requests.map((request) => request.path).sort()
    ).toEqual([assetPath, checksumsPath].sort());
  });

  test("GH_DOWNLOAD=curl forces the curl fallback: the proxy serves a curl client", async () => {
    const { proxy } = await serveReleaseBehindProxy();
    const result = await harness.spawnShim(["--version"], {
      env: { http_proxy: proxy.url, GH_DOWNLOAD: "curl" },
    });

    expect(result.exitCode).toBe(0);
    expect(proxy.requests).toHaveLength(2);
    for (const request of proxy.requests) {
      expect(request.userAgent).toContain("curl");
    }
  });

  test("npm's proxy configuration in ~/.npmrc routes downloads through the proxy", async () => {
    const {
      proxy,
      assetUrl,
      checksumsUrl,
      assetPath,
      checksumsPath,
      cacheBinaryPath,
    } = await serveReleaseBehindProxy();
    writeFileSync(join(harness.sandbox.home, ".npmrc"), `proxy=${proxy.url}\n`);
    const result = await harness.spawnShim(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(proxiedAuthorities(proxy).sort()).toEqual(
      [new URL(assetUrl).host, new URL(checksumsUrl).host].sort()
    );
    expect(
      harness.mirror.requests.map((request) => request.path).sort()
    ).toEqual([assetPath, checksumsPath].sort());
    expect(existsSync(cacheBinaryPath)).toBe(true);
  });

  test("npm_config_proxy in the environment (npm script context) routes downloads through the proxy", async () => {
    const { proxy } = await serveReleaseBehindProxy();
    const result = await harness.spawnShim(["--version"], {
      env: { npm_config_proxy: proxy.url },
    });

    expect(result.exitCode).toBe(0);
    expect(proxy.requests).toHaveLength(2);
  });

  test("an npm-configured proxy under an already-active env-proxy run is served by the curl fallback", async () => {
    const { proxy } = await serveReleaseBehindProxy();
    const result = await harness.spawnShim(["--version"], {
      env: { NODE_USE_ENV_PROXY: "1", npm_config_proxy: proxy.url },
    });

    expect(result.exitCode).toBe(0);
    expect(proxy.requests).toHaveLength(2);
    for (const request of proxy.requests) {
      expect(request.userAgent).toContain("curl");
    }
  });
});
