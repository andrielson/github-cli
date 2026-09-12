import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const packageRoot = join(import.meta.dir, "..", "..");
const repoRoot = join(packageRoot, "..", "..");

/** The shim's thin executable entry — what `bin.gh` in the manifest points at. */
export const shimEntryPath = join(packageRoot, "bin", "gh.js");

/**
 * Build the single-bundle shim with the repo's bun toolchain, via the root
 * `build` script (the one place the bundle invocation is defined). Every
 * suite run rebuilds; the bundle is throwaway.
 */
export function buildShim(): void {
  const result = spawnSync(process.execPath, ["run", "build"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `building the shim bundle failed (exit ${result.status}):\n${result.stdout}${result.stderr}`
    );
  }
}

export type MirrorRequest = { method: string; path: string };

export type Mirror = {
  /**
   * Base URL a sandboxed shim would download through (the harness sets it as
   * `GH_MIRROR`). Any request landing here means the shim touched the network.
   */
  url: string;
  /** Every request received so far — the no-network canary. */
  requests: MirrorRequest[];
  /** Register a fixture file the mirror serves at `path`. */
  serve(
    path: string,
    body: string | Uint8Array,
    headers?: Record<string, string>
  ): void;
  /** Stop the server; resolves once the port is released. */
  stop(): Promise<void>;
};

/**
 * A local fixture HTTP mirror: the download source stand-in for every
 * network-facing test. It serves only what `serve()` registered and records
 * every request it receives.
 */
export function startMirror(): Promise<Mirror> {
  const requests: MirrorRequest[] = [];
  const fixtures = new Map<
    string,
    { body: Buffer; headers: Record<string, string> }
  >();
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", path: request.url ?? "" });
    const fixture = fixtures.get(request.url ?? "");
    if (fixture === undefined) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      ...fixture.headers,
      "content-length": fixture.body.length,
    });
    response.end(fixture.body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the fixture mirror could not bind an IPv4 port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        serve(path, body, headers = {}) {
          fixtures.set(path, { body: Buffer.from(body), headers });
        },
        stop() {
          return new Promise((resolveStop, rejectStop) => {
            server.close((error) => {
              if (error) {
                rejectStop(error);
              } else {
                resolveStop();
              }
            });
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}

export type Sandbox = {
  /** Root of the sandbox; every sandboxed location lives under here. */
  root: string;
  /** Sandboxed `HOME`. */
  home: string;
  /** Sandboxed `XDG_CACHE_HOME` — the Linux cache root. */
  cacheHome: string;
  /** Sandboxed `LOCALAPPDATA` — parent of the Windows cache root. */
  localAppData: string;
  /**
   * Clean-room environment for spawning the shim: system `PATH` plus the
   * sandboxed locations plus any extras. Nothing leaks in from the host, so
   * `GH_BINARY`/`GH_MIRROR` are unset unless a test sets them.
   */
  env: Record<string, string>;
  /** Every file and directory under the sandbox, as sorted relative paths. */
  listTree(): string[];
};

function windowsEnv(): Record<string, string> {
  if (process.platform !== "win32") {
    return {};
  }
  const env: Record<string, string> = {};
  for (const name of ["SYSTEMROOT", "SYSTEMDRIVE", "ComSpec", "PATHEXT"]) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * A temporary sandbox standing in for the user's machine: `HOME` and every
 * OS cache location point inside it, so any cache write is visible in
 * `listTree()` and any temp file lands in `tmp/`.
 */
export function createSandbox(extraEnv: Record<string, string> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "gh-wrapper-seam1-"));
  const home = join(root, "home");
  const cacheHome = join(root, "cache");
  const localAppData = join(root, "localappdata");
  const tmp = join(root, "tmp");
  for (const dir of [home, cacheHome, localAppData, tmp]) {
    mkdirSync(dir);
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CACHE_HOME: cacheHome,
    LOCALAPPDATA: localAppData,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    ...windowsEnv(),
    ...extraEnv,
  };
  const listTree = (): string[] => {
    const entries: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir).sort()) {
        const path = join(dir, entry);
        entries.push(relative(root, path).split(sep).join("/"));
        if (statSync(path).isDirectory()) {
          walk(path);
        }
      }
    };
    walk(root);
    return entries;
  };
  return { root, home, cacheHome, localAppData, env, listTree };
}

export type StubGhOptions = {
  /** Exit code the stub reports (default 0). */
  exitCode?: number;
  /** Marker line the stub writes to stderr (omitted when not set). */
  stderr?: string;
};

/**
 * Write an executable stub `gh` binary into `dir`. The stub reports what the
 * shim handed it on stdout (one JSON line: `{ args, stdin }`), an optional
 * marker on stderr, and exits with the configured code — enough to verify
 * argument, stdio and exit-code passthrough at the outermost boundary.
 */
function writeStubGh(
  dir: string,
  serial: number,
  options: StubGhOptions
): string {
  const exitCode = options.exitCode ?? 0;
  const stderrMarker = options.stderr ?? "";
  const path = join(dir, `stub-gh-${serial}.js`);
  const script = [
    "#!/usr/bin/env node",
    '"use strict";',
    "",
    `const exitCode = ${JSON.stringify(exitCode)};`,
    `const stderrMarker = ${JSON.stringify(stderrMarker)};`,
    "const args = process.argv.slice(2);",
    'let stdin = "";',
    "let finished = false;",
    "const finish = () => {",
    "  if (finished) return;",
    "  finished = true;",
    '  process.stdout.write(JSON.stringify({ args, stdin }) + "\\n");',
    '  if (stderrMarker !== "") process.stderr.write(stderrMarker + "\\n");',
    "  process.exit(exitCode);",
    "};",
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    "  stdin += chunk;",
    "});",
    'process.stdin.on("end", finish);',
    'process.stdin.on("error", finish);',
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

export type SpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type SpawnShimOptions = {
  /** String piped to the shim's stdin; when omitted, stdin is ignored. */
  input?: string;
  /** Extra environment layered over the sandbox environment. */
  env?: Record<string, string>;
};

export type Harness = {
  sandbox: Sandbox;
  mirror: Mirror;
  /** Write a stub `gh` binary into the sandbox; returns its path. */
  stubGh(options?: StubGhOptions): string;
  /** Spawn the built shim at the process boundary in the sandbox. */
  spawnShim(args: string[], options?: SpawnShimOptions): Promise<SpawnResult>;
  /** Remove the sandbox and stop the mirror. */
  cleanup(): Promise<void>;
};

/**
 * The seam-1 harness: sandboxed spawn of the real shim, a fixture mirror the
 * sandbox points at (`GH_MIRROR`), and stub `gh` binaries for the override
 * path. Reused by every wrapper ticket that tests at the process boundary.
 */
export async function createHarness(
  options: { env?: Record<string, string> } = {}
): Promise<Harness> {
  const mirror = await startMirror();
  const sandbox = createSandbox({ GH_MIRROR: mirror.url, ...options.env });
  const stubDir = join(sandbox.root, "stubs");
  mkdirSync(stubDir);
  let stubCount = 0;
  const spawnShim = async (
    args: string[],
    spawnOptions: SpawnShimOptions = {}
  ): Promise<SpawnResult> => {
    const proc = Bun.spawn([shimEntryPath, ...args], {
      env: { ...sandbox.env, ...spawnOptions.env },
      stdin: spawnOptions.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (spawnOptions.input !== undefined && proc.stdin !== null) {
      proc.stdin.write(spawnOptions.input);
      proc.stdin.end();
    }
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  };
  return {
    sandbox,
    mirror,
    stubGh: (stubOptions: StubGhOptions = {}) =>
      writeStubGh(stubDir, ++stubCount, stubOptions),
    spawnShim,
    cleanup: async () => {
      rmSync(sandbox.root, { recursive: true, force: true });
      await mirror.stop();
    },
  };
}
