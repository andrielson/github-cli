import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";

/** The binary override: a user-set pointer to an existing gh binary. */
const BINARY_OVERRIDE_ENV = "GH_BINARY";
/** The mirror override: the download base URL to use instead of upstream. */
const MIRROR_OVERRIDE_ENV = "GH_MIRROR";
/** Platform-detection overrides (advanced: pre-seeding a cache, debugging). */
const PLATFORM_OVERRIDE_ENV = "GH_PLATFORM";
const ARCH_OVERRIDE_ENV = "GH_ARCH";
/** The download-mechanism override (advanced: debugging proxy corners). */
const DOWNLOAD_OVERRIDE_ENV = "GH_DOWNLOAD";
/**
 * Marks the proxy-aware re-run of the shim: Node's fetch then honours the
 * standard proxy environment variables through its global dispatcher. The
 * mechanism only engages at process start, so the shim re-runs itself with it
 * set when a proxied download is due.
 */
const ENV_PROXY_ENV = "NODE_USE_ENV_PROXY";

/** Upstream release assets live under this base, one directory per version. */
const DEFAULT_DOWNLOAD_BASE = "https://github.com/cli/cli/releases/download";

/** The wrapper's shared cache directory name (ADR 0002). */
const CACHE_DIR_NAME = "gh-wrapper";

/** The binary override path, or undefined when unset (or empty). */
function binaryOverride(): string | undefined {
  const path = process.env[BINARY_OVERRIDE_ENV];
  return path !== undefined && path !== "" ? path : undefined;
}

/** Report a shim-owned message to the user on stderr, gh-style. */
function inform(message: string): void {
  process.stderr.write(`gh: ${message}\n`);
}

function fail(message: string): void {
  inform(message);
  process.exitCode = 1;
}

/**
 * Execute `command` with `args`, wiring stdio straight through, and mirror its
 * exit. `origin` names what is being executed, so a failed spawn can point the
 * user at the right thing to fix.
 */
function runCommandLine(
  command: string,
  args: string[],
  origin: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const child = spawn(command, args, { stdio: "inherit", env });
  child.on("error", (error) => {
    fail(`could not execute ${origin}: ${error.message}`);
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

/**
 * Execute a gh binary with the caller's arguments, wiring stdio straight
 * through, and mirror its exit. `origin` names where the binary came from, so
 * a failed spawn can point the user at the right thing to fix.
 */
function runBinary(binaryPath: string, origin: string): void {
  runCommandLine(binaryPath, process.argv.slice(2), origin);
}

/** The platform-dependent shape of an upstream release asset. */
type Target = {
  /** The OS segment of the asset name: `macOS` mixed-case, others lowercase. */
  assetOs: string;
  /** The architecture segment of the asset name: `amd64` or `arm64`. */
  assetArch: string;
  /** The archive extension: `.tar.gz` on linux, `.zip` on macOS and Windows. */
  extension: string;
  /** The binary file name inside the archive and the cache. */
  binaryName: string;
};

/** Map a platform/architecture pair onto the upstream asset naming, or null. */
function describeTarget(platform: string, arch: string): Target | null {
  const assetArch =
    arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (assetArch === null) {
    return null;
  }
  switch (platform) {
    case "linux":
      return {
        assetOs: "linux",
        assetArch,
        extension: ".tar.gz",
        binaryName: "gh",
      };
    case "darwin":
      return {
        assetOs: "macOS",
        assetArch,
        extension: ".zip",
        binaryName: "gh",
      };
    case "win32":
      return {
        assetOs: "windows",
        assetArch,
        extension: ".zip",
        binaryName: "gh.exe",
      };
    default:
      return null;
  }
}

function unsupportedPlatformMessage(platform: string, arch: string): string {
  return (
    `${platform}/${arch} is not a supported platform for @andrielson/gh ` +
    `(supported: linux, macOS and Windows on amd64 or arm64). Install the ` +
    `GitHub CLI manually instead — see https://github.com/cli/cli#installation ` +
    `for the official channels (for example brew install gh on macOS, ` +
    `scoop install gh on Windows, or your distribution's gh package on Linux)`
  );
}

/**
 * The OS-native root of the shared per-version cache (ADR 0002):
 * `$XDG_CACHE_HOME`/`~/.cache` on linux, `~/Library/Caches` on macOS,
 * `%LOCALAPPDATA%\gh-wrapper\Cache` on Windows.
 */
function cacheRoot(platform: string): string {
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, CACHE_DIR_NAME, "Cache");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Caches", CACHE_DIR_NAME);
  }
  const xdgCacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(xdgCacheHome, CACHE_DIR_NAME);
}

/**
 * The one place the cache slot for a version's binary is spelled: the OS-native
 * cache root plus `<version>/bin/<binary>` (ADR 0002).
 */
function cacheBinaryPath(
  platform: string,
  version: string,
  binaryName: string
): string {
  return join(cacheRoot(platform), version, "bin", binaryName);
}

/**
 * A proxy a download must travel through, and where it was configured: `env`
 * for the standard proxy environment variables (the ones Node's env-honouring
 * dispatcher reads), `npm` for npm's proxy configuration.
 */
type ResolvedProxy = {
  url: string;
  source: "env" | "npm";
};

/**
 * The proxy-configured key names for a download URL, per source: the standard
 * environment variables (`https_proxy` for https URLs, `http_proxy` for http
 * ones, both spellings accepted), npm's environment mapping, and the npmrc
 * file (`https-proxy`/`proxy`, npm's own precedence: https-specific first).
 */
function proxyKeyNames(url: URL): {
  standardEnv: string[];
  npmEnv: string[];
  npmrc: string[];
} {
  if (url.protocol === "https:") {
    return {
      standardEnv: ["https_proxy", "HTTPS_PROXY"],
      npmEnv: ["npm_config_https_proxy", "npm_config_proxy"],
      npmrc: ["https-proxy", "proxy"],
    };
  }
  return {
    standardEnv: ["http_proxy", "HTTP_PROXY"],
    npmEnv: ["npm_config_proxy"],
    npmrc: ["proxy"],
  };
}

/** The first defined, non-empty value among the environment `names`. */
function firstEnvValue(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return null;
}

/**
 * Whether `host` is excluded from proxying by the `no_proxy` variable,
 * curl-style: `*` excludes everything; an entry matches the host exactly or
 * as a dot-boundary suffix (`example.com` covers `sub.example.com`).
 */
function noProxyMatches(host: string): boolean {
  const list = firstEnvValue("no_proxy", "NO_PROXY");
  if (list === null) {
    return false;
  }
  for (const rawEntry of list.split(",")) {
    const entry = rawEntry.trim().replace(/^\./, "");
    if (
      entry === "*" ||
      (entry !== "" && (host === entry || host.endsWith(`.${entry}`)))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The user's npmrc as key/value pairs, or an empty map when there is none to
 * read. Flat INI shape: `key = value` lines, `#`/`;` comments, optional
 * surrounding quotes; `false`/`null` values count as unset (how npm spells a
 * disabled proxy).
 */
function readUserNpmrc(): Map<string, string> {
  const config = new Map<string, string>();
  const path = process.env.NPM_CONFIG_USERCONFIG ?? join(homedir(), ".npmrc");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return config;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== "" && value !== "false" && value !== "null") {
      config.set(key, value);
    }
  }
  return config;
}

/**
 * The proxy npm would use for `url`: npm-mapped environment configuration
 * first (how npm exposes its config to scripts), then the user's npmrc. Null
 * when npm configures no proxy.
 */
function npmConfigProxy(url: URL): string | null {
  const { npmEnv, npmrc: npmrcKeys } = proxyKeyNames(url);
  const fromEnv = firstEnvValue(...npmEnv);
  if (fromEnv !== null) {
    return fromEnv;
  }
  const npmrc = readUserNpmrc();
  for (const key of npmrcKeys) {
    const value = npmrc.get(key);
    if (value !== undefined) {
      return value;
    }
  }
  return null;
}

/**
 * The proxy a download of `url` must travel through, or null for a direct
 * download: the standard environment variables first, then npm's proxy
 * configuration, with `no_proxy` exclusions applied before either source is
 * consulted.
 */
function proxyForUrl(url: URL): ResolvedProxy | null {
  if (noProxyMatches(url.hostname)) {
    return null;
  }
  const fromEnv = firstEnvValue(...proxyKeyNames(url).standardEnv);
  if (fromEnv !== null) {
    return { url: fromEnv, source: "env" };
  }
  const fromNpm = npmConfigProxy(url);
  if (fromNpm !== null) {
    return { url: fromNpm, source: "npm" };
  }
  return null;
}

/**
 * Download `url` with Node's fetch — the direct route, and the proxied route
 * whenever the env-honouring global dispatcher is live for this process.
 */
async function fetchDownload(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`could not reach ${url}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`downloading ${url} failed: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Download `url` with curl — the non-fetch fallback for the runtimes and
 * proxy corner cases the env-honouring fetch route cannot serve. The proxy is
 * passed explicitly, so npm-configured proxies reach curl too.
 */
function curlDownload(url: string, proxyUrl: string | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ["--fail", "--silent", "--show-error", "--location"];
    if (proxyUrl !== null) {
      args.push("--proxy", proxyUrl);
    }
    args.push(url);
    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let failureDetail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      failureDetail += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(new Error(`could not run curl to fetch ${url}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`downloading ${url} failed: ${failureDetail.trim()}`));
      }
    });
  });
}

/** Whether the user forced the curl route with the download-mechanism override. */
function curlForced(): boolean {
  return process.env[DOWNLOAD_OVERRIDE_ENV] === "curl";
}

/** Whether this process already runs with Node's env-honouring fetch dispatcher live. */
function envProxyRunActive(): boolean {
  return process.env[ENV_PROXY_ENV] === "1";
}

/** Whether this Node understands NODE_USE_ENV_PROXY (added in v22.21; every release from v24 on has it). */
function nodeSupportsEnvProxy(): boolean {
  const match = /^v(\d+)\.(\d+)/.exec(process.version);
  if (match === null) {
    return false;
  }
  const major = Number(match[1]);
  return major >= 24 || (major === 22 && Number(match[2]) >= 21);
}

/**
 * Whether `proxy` cannot be served by plain fetch in this process: an active
 * env-proxy run honours only the standard environment variables, so an
 * npm-configured proxy needs curl; without an active run, supporting runtimes
 * have already been delegated to the proxy-aware re-run, so what is left is a
 * runtime without the mechanism.
 */
function curlRequired(proxy: ResolvedProxy): boolean {
  if (envProxyRunActive()) {
    return proxy.source !== "env";
  }
  return !nodeSupportsEnvProxy();
}

/**
 * Download `url`, honouring the resolved proxy configuration: direct
 * downloads stay a plain fetch; proxied downloads go through the env-honouring
 * global dispatcher when that route is live, and through curl otherwise.
 */
async function download(url: string): Promise<Buffer> {
  const proxy = proxyForUrl(new URL(url));
  if (curlForced()) {
    return curlDownload(url, proxy?.url ?? null);
  }
  if (proxy === null || !curlRequired(proxy)) {
    return fetchDownload(url);
  }
  return curlDownload(url, proxy.url);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The expected SHA-256 for `assetName` from a `sha256sum`-format checksums
 * file, or null when the file has no entry for the asset.
 */
function expectedChecksum(
  checksumsText: string,
  assetName: string
): string | null {
  for (const line of checksumsText.split("\n")) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (match !== null && match[2] === assetName) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

/**
 * The tar executable to invoke: on Windows, the operating system's own bsdtar,
 * resolved explicitly — a tar earlier on PATH (GNU tar under git-bash) both
 * misparses drive-letter paths as remote-host specs and cannot read the
 * upstream `.zip` archives at all. Elsewhere, the system tar (GNU tar on
 * linux, bsdtar on macOS), which reads both archive formats and auto-detects
 * compression.
 */
function systemTarCommand(): string {
  if (process.platform === "win32") {
    const systemTar = join(
      process.env.SYSTEMROOT ?? "C:\\Windows",
      "System32",
      "tar.exe"
    );
    if (existsSync(systemTar)) {
      return systemTar;
    }
  }
  return "tar";
}

function runTar(args: string[]): string {
  // The system tar's portable flags are the short ones, so long-form-only
  // style is not possible across the tar flavors.
  const result = spawnSync(systemTarCommand(), args, { encoding: "utf8" });
  if (result.error !== undefined) {
    throw new Error(`could not run the system tar: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `tar ${args.join(" ")} failed (exit ${result.status}): ${result.stderr.trim()}`
    );
  }
  return result.stdout;
}

/**
 * Extract the binary from the release archive into `destinationDir` and return
 * its path there. The archive's versioned root directory is located by listing
 * the members — never assumed by name — and only the `bin/gh` member is
 * extracted, with the root stripped.
 */
function extractBinary(
  archivePath: string,
  destinationDir: string,
  binaryName: string
): string {
  const memberPattern = new RegExp(
    `^[^/]+/bin/${binaryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
  );
  const members = runTar(["-tf", archivePath])
    .split("\n")
    .map((member) => member.replace(/^\.\//, "").trim())
    .filter((member) => memberPattern.test(member));
  if (members.length !== 1) {
    throw new Error(
      `the archive ${archivePath} contains ${members.length} ` +
        `'<root>/bin/${binaryName}' members, expected exactly one`
    );
  }
  runTar([
    "-xf",
    archivePath,
    "-C",
    destinationDir,
    "--strip-components",
    "1",
    members[0],
  ]);
  return join(destinationDir, "bin", binaryName);
}

/**
 * Move the verified binary from its staging directory into its cache slot with
 * a single atomic rename. A rival concurrent install may have populated the
 * same slot first; on Windows that surfaces as EPERM/EEXIST and counts as
 * success — the rival placed the identical verified binary (ADR 0002).
 */
function populateCache(stagedBinary: string, finalBinary: string): void {
  mkdirSync(dirname(finalBinary), { recursive: true });
  chmodSync(stagedBinary, 0o755);
  try {
    renameSync(stagedBinary, finalBinary);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32" &&
      (code === "EPERM" || code === "EEXIST")
    ) {
      return;
    }
    throw error;
  }
}

/** Where the wrapper's own release lives on the configured download base. */
type ReleaseUrls = {
  /** The upstream asset name, e.g. `gh_2.100.0_linux_amd64.tar.gz`. */
  assetName: string;
  checksumsUrl: string;
  assetUrl: string;
};

/**
 * The URLs and asset name of the wrapper's own release on the configured
 * download base: `<base>/v<version>/…`, upstream by default, the mirror
 * override when set.
 */
function releaseAssetUrls(local: LocalTarget): ReleaseUrls {
  const { version, target } = local;
  const assetName = `gh_${version}_${target.assetOs}_${target.assetArch}${target.extension}`;
  const downloadBase = (
    process.env[MIRROR_OVERRIDE_ENV] ?? DEFAULT_DOWNLOAD_BASE
  ).replace(/\/+$/, "");
  const releaseBase = `${downloadBase}/v${version}`;
  return {
    assetName,
    checksumsUrl: `${releaseBase}/gh_${version}_checksums.txt`,
    assetUrl: `${releaseBase}/${assetName}`,
  };
}

/**
 * The lazy download (ADR 0001): fetch the archive and the checksums file for
 * the wrapper's own version, verify fail-closed, extract the binary from the
 * versioned archive root, and stage it into the shared per-version cache
 * atomically. Any failure leaves nothing cached and throws.
 */
async function installIntoCache(local: LocalTarget): Promise<void> {
  const { platform, version, target, finalBinary } = local;
  const { assetName, checksumsUrl, assetUrl } = releaseAssetUrls(local);
  const root = cacheRoot(platform);

  inform(
    `downloading the GitHub CLI ${version} from ${dirname(checksumsUrl)} …`
  );
  const checksumsText = (await download(checksumsUrl)).toString("utf8");
  const expected = expectedChecksum(checksumsText, assetName);
  if (expected === null) {
    throw new Error(
      `the checksums file at ${checksumsUrl} has no entry for ${assetName}; ` +
        `refusing to install an archive that cannot be verified`
    );
  }

  const archive = await download(assetUrl);
  const actual = sha256(archive);
  if (actual !== expected) {
    throw new Error(
      `checksum verification failed for ${assetName}: expected ${expected}, ` +
        `got ${actual} — the downloaded archive does not match its checksums ` +
        `file; nothing was cached or executed`
    );
  }

  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, "staging-"));
  try {
    const archivePath = join(staging, assetName);
    writeFileSync(archivePath, archive);
    const stagedBinary = extractBinary(archivePath, staging, target.binaryName);
    populateCache(stagedBinary, finalBinary);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Everything the shim needs to find this machine's cache slot for its own
 * version — or a report that this platform has no upstream asset at all.
 */
type LocalTarget = {
  platform: string;
  version: string;
  target: Target;
  finalBinary: string;
};

/**
 * Resolve the wrapper's own version onto this machine's platform and cache
 * slot. Null means the platform is unsupported and the failure — the
 * manual-install message — has already been reported.
 */
function resolveLocalTarget(): LocalTarget | null {
  const platform = process.env[PLATFORM_OVERRIDE_ENV] ?? process.platform;
  const arch = process.env[ARCH_OVERRIDE_ENV] ?? process.arch;
  const target = describeTarget(platform, arch);
  if (target === null) {
    fail(unsupportedPlatformMessage(platform, arch));
    return null;
  }
  const version = pkg.version;
  return {
    platform,
    version,
    target,
    finalBinary: cacheBinaryPath(platform, version, target.binaryName),
  };
}

/**
 * Run the lazy download, converting any failure into a clean abort whose
 * recovery hint names the exact command to retry: every failure of the
 * download step leaves nothing cached, and `gh install` is the idempotent
 * retry. False means the failure has already been reported.
 */
async function installOrAbort(local: LocalTarget): Promise<boolean> {
  try {
    await installIntoCache(local);
    return true;
  } catch (error) {
    fail((error as Error).message);
    inform("to retry the download, run: gh install");
    return false;
  }
}

/**
 * The proxy-aware re-run gate: when a proxied download is due on a runtime
 * that supports Node's env-honouring proxy dispatcher, delegate the whole run
 * to a fresh copy of this shim started with NODE_USE_ENV_PROXY=1 — the
 * mechanism engages only at process start. An npm-configured proxy is
 * injected as the matching standard variable so the dispatcher sees it.
 * True means the run was delegated and the caller has nothing left to do.
 */
function delegateToEnvProxyRun(local: LocalTarget): boolean {
  const url = new URL(releaseAssetUrls(local).checksumsUrl);
  const proxy = proxyForUrl(url);
  if (
    proxy === null ||
    curlForced() ||
    envProxyRunActive() ||
    !nodeSupportsEnvProxy()
  ) {
    return false;
  }
  const env: NodeJS.ProcessEnv = { ...process.env, [ENV_PROXY_ENV]: "1" };
  if (proxy.source === "npm") {
    env[proxyKeyNames(url).standardEnv[0]] = proxy.url;
  }
  runCommandLine(
    process.execPath,
    [process.argv[1], ...process.argv.slice(2)],
    "the proxy-aware re-run of the shim",
    env
  );
  return true;
}

/**
 * `gh install` — the intercepted prefetch subcommand (upstream `gh` defines
 * no install command; ADR 0001): an explicit, idempotent request to fetch the
 * wrapper's own version into the cache ahead of first use, for CI and scripted
 * setups. It never re-executes the binary: a populated cache makes it a no-op,
 * and so does the binary override, since the wrapper then manages no binary.
 */
async function installCommand(): Promise<void> {
  const overridePath = binaryOverride();
  if (overridePath !== undefined) {
    inform(
      `${BINARY_OVERRIDE_ENV} is set — the wrapper manages no binary of its own, so there is nothing to install`
    );
    return;
  }

  const local = resolveLocalTarget();
  if (local === null) {
    return;
  }
  if (existsSync(local.finalBinary)) {
    inform(
      `the GitHub CLI ${local.version} is already cached at ${local.finalBinary}`
    );
    return;
  }
  if (delegateToEnvProxyRun(local)) {
    return;
  }
  if (await installOrAbort(local)) {
    inform(
      `the GitHub CLI ${local.version} is now cached at ${local.finalBinary}`
    );
  }
}

async function main(): Promise<void> {
  // `gh install` is intercepted before everything else — including the binary
  // override, so CI scripts can call it unconditionally: with the override set
  // it is a friendly no-op rather than an unknown-command error.
  if (process.argv[2] === "install") {
    await installCommand();
    return;
  }

  const overridePath = binaryOverride();
  if (overridePath !== undefined) {
    runBinary(
      overridePath,
      `the binary override ${BINARY_OVERRIDE_ENV}=${overridePath}`
    );
    return;
  }

  const local = resolveLocalTarget();
  if (local === null) {
    return;
  }
  if (existsSync(local.finalBinary)) {
    runBinary(
      local.finalBinary,
      `the cached gh binary at ${local.finalBinary}`
    );
    return;
  }

  if (delegateToEnvProxyRun(local)) {
    return;
  }

  if (await installOrAbort(local)) {
    runBinary(local.finalBinary, `the gh binary at ${local.finalBinary}`);
  }
}

main().catch((error: unknown) => {
  fail((error as Error).message);
});
