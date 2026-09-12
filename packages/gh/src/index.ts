import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

/** Upstream release assets live under this base, one directory per version. */
const DEFAULT_DOWNLOAD_BASE = "https://github.com/cli/cli/releases/download";

/** The wrapper's shared cache directory name (ADR 0002). */
const CACHE_DIR_NAME = "gh-wrapper";

function fail(message: string): void {
  process.stderr.write(`gh: ${message}\n`);
  process.exitCode = 1;
}

/**
 * Execute a gh binary with the caller's arguments, wiring stdio straight
 * through, and mirror its exit. `origin` names where the binary came from, so
 * a failed spawn can point the user at the right thing to fix.
 */
function runBinary(binaryPath: string, origin: string): void {
  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: "inherit",
  });
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

async function download(url: string): Promise<Buffer> {
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

function runTar(args: string[]): string {
  // The system tar (GNU tar on linux, bsdtar on macOS and Windows) reads both
  // archive formats and auto-detects compression. Its portable flags are the
  // short ones, so long-form-only style is not possible across all three tars.
  const result = spawnSync("tar", args, { encoding: "utf8" });
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

/**
 * The lazy download (ADR 0001): fetch the archive and the checksums file for
 * the wrapper's own version, verify fail-closed, extract the binary from the
 * versioned archive root, and stage it into the shared per-version cache
 * atomically. Any failure leaves nothing cached and throws.
 */
async function installIntoCache(
  version: string,
  target: Target,
  platform: string
): Promise<string> {
  const assetName = `gh_${version}_${target.assetOs}_${target.assetArch}${target.extension}`;
  const downloadBase = (
    process.env[MIRROR_OVERRIDE_ENV] ?? DEFAULT_DOWNLOAD_BASE
  ).replace(/\/+$/, "");
  const releaseBase = `${downloadBase}/v${version}`;
  const checksumsUrl = `${releaseBase}/gh_${version}_checksums.txt`;
  const assetUrl = `${releaseBase}/${assetName}`;

  const root = cacheRoot(platform);
  const finalBinary = cacheBinaryPath(platform, version, target.binaryName);

  process.stderr.write(
    `gh: first run: downloading the GitHub CLI ${version} from ${releaseBase} …\n`
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
  return finalBinary;
}

async function main(): Promise<void> {
  const overridePath = process.env[BINARY_OVERRIDE_ENV];
  if (overridePath !== undefined && overridePath !== "") {
    runBinary(
      overridePath,
      `the binary override ${BINARY_OVERRIDE_ENV}=${overridePath}`
    );
    return;
  }

  const platform = process.env[PLATFORM_OVERRIDE_ENV] ?? process.platform;
  const arch = process.env[ARCH_OVERRIDE_ENV] ?? process.arch;
  const target = describeTarget(platform, arch);
  if (target === null) {
    fail(unsupportedPlatformMessage(platform, arch));
    return;
  }

  const version = pkg.version;
  const finalBinary = cacheBinaryPath(platform, version, target.binaryName);
  if (existsSync(finalBinary)) {
    runBinary(finalBinary, `the cached gh binary at ${finalBinary}`);
    return;
  }

  const binary = await installIntoCache(version, target, platform);
  runBinary(binary, `the gh binary at ${binary}`);
}

main().catch((error: unknown) => {
  fail((error as Error).message);
});
