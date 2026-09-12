/**
 * Release-automation decision logic (seam 2 of the spec): given fixture-shaped
 * GitHub-API and npm-registry data, compute the next missing version to
 * publish — ascending from the backfill floor, skipping versions already on
 * the registry — or report that none remain. A pure module: no network, no
 * filesystem, no clock; the backfill and poll workflows feed it real data.
 */

/** A single upstream release, as the GitHub API shapes the relevant fields. */
export type UpstreamRelease = {
  /** The release's git tag, e.g. "v2.100.0" or "v2.101.0-rc1". */
  tag: string;
  /** The authoritative prerelease flag from the release object. */
  prerelease: boolean;
};

export type ReleaseDecisionInput = {
  upstreamReleases: UpstreamRelease[];
  /** Versions the npm registry already holds, bare (e.g. "2.100.0"). */
  registryVersions: string[];
  /** The committed backfill version list, bare, in any order. */
  backfillVersions: string[];
  /** The oldest version eligible for publication, bare (e.g. "2.28.0"). */
  backfillFloor: string;
};

export type ReleaseDecision =
  | { outcome: "publish"; version: string }
  | { outcome: "caught-up" }
  | { outcome: "abort"; reason: string };

/** A parsed semver version; build metadata is ignored (no precedence). */
type Semver = {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty when the version is stable. */
  prerelease: string[];
};

const SEMVER_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
const SEMVER_PATTERN = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
    `(?:-(${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*))?$`
);

/** Parse a bare semver version; `null` when it does not parse. */
function parseVersion(input: string): Semver | null {
  const match = input.split("+")[0].match(SEMVER_PATTERN);
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

/** Parse an upstream git tag: a bare version with an optional "v" prefix. */
function parseTag(tag: string): Semver | null {
  return parseVersion(tag.startsWith("v") ? tag.slice(1) : tag);
}

/** The canonical bare form (no "v", no build metadata) — npm's spelling. */
function canonical(version: Semver): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0
    ? base
    : `${base}-${version.prerelease.join(".")}`;
}

/** Semver precedence comparison: negative when `left` sorts before `right`. */
function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return left.prerelease.length - right.prerelease.length;
}

/**
 * Decide the next version to publish. The candidate universe is every stable
 * version at or above the backfill floor — from the committed backfill list
 * and from stable upstream releases (which also cover versions newer than
 * the list) — minus what the registry already holds. Pre-releases are never
 * candidates under any dist-tag.
 */
export function decideNextRelease(
  input: ReleaseDecisionInput
): ReleaseDecision {
  const floor = parseVersion(input.backfillFloor);
  if (floor === null) {
    return {
      outcome: "abort",
      reason: `the backfill floor ${input.backfillFloor} is not a valid semver version`,
    };
  }

  const candidates = new Map<string, Semver>();
  for (const release of input.upstreamReleases) {
    const version = parseTag(release.tag);
    if (version === null) {
      return {
        outcome: "abort",
        reason: `upstream tag ${release.tag} is not a valid semver version`,
      };
    }
    // The release object's prerelease flag is authoritative, cross-checked
    // against the tag's semver shape: a disagreement means upstream's release
    // data contradicts itself, and no version mapping can be trusted.
    const tagIsPrerelease = version.prerelease.length > 0;
    if (release.prerelease !== tagIsPrerelease) {
      return {
        outcome: "abort",
        reason: release.prerelease
          ? `upstream tag ${release.tag} is flagged as a prerelease, but its semver has no prerelease segment`
          : `upstream tag ${release.tag} is flagged stable, but its semver has a prerelease segment`,
      };
    }
    if (!release.prerelease && compareSemver(version, floor) >= 0) {
      candidates.set(canonical(version), version);
    }
  }

  const registry = new Set<string>();
  // Registry state is external: entries the backfill could never produce
  // (e.g. a prerelease) are inert for this decision, not abort material —
  // unlike our own lists below, which must be clean.
  for (const version of input.registryVersions) {
    const parsed = parseVersion(version);
    if (parsed === null) {
      return {
        outcome: "abort",
        reason: `npm registry version ${version} is not a valid semver version`,
      };
    }
    registry.add(canonical(parsed));
  }

  for (const version of input.backfillVersions) {
    const parsed = parseVersion(version);
    if (parsed === null) {
      return {
        outcome: "abort",
        reason: `backfill version ${version} is not a valid semver version`,
      };
    }
    if (parsed.prerelease.length > 0) {
      return {
        outcome: "abort",
        reason: `backfill version ${version} is a prerelease; the backfill publishes stable versions only`,
      };
    }
    if (compareSemver(parsed, floor) >= 0) {
      candidates.set(canonical(parsed), parsed);
    }
  }

  let next: { key: string; version: Semver } | null = null;
  for (const [key, version] of candidates) {
    if (registry.has(key)) continue;
    if (next === null || compareSemver(version, next.version) < 0) {
      next = { key, version };
    }
  }
  if (next === null) {
    return { outcome: "caught-up" };
  }
  return { outcome: "publish", version: next.key };
}
