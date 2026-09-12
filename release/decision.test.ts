import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideNextRelease } from "./decision";

/**
 * The committed backfill list — fixture input per the spec ("the committed
 * backfill version list doubles as fixture input for seam 2"), parsed the
 * way the future workflow glue will parse it.
 */
const committedBackfill = readFileSync(
  join(import.meta.dir, "..", "backfill", "versions.txt"),
  "utf8"
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "");

describe("the release decision module, at its boundary (seam 2)", () => {
  describe("next missing version", () => {
    test("the committed backfill list is 100 stable versions from 2.28.0 to 2.100.0", () => {
      expect(committedBackfill).toHaveLength(100);
      expect(committedBackfill[0]).toBe("2.28.0");
      expect(committedBackfill.at(-1)).toBe("2.100.0");
      for (const version of committedBackfill) {
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      }
    });

    test("with an empty registry, the next missing version is the backfill floor", () => {
      const decision = decideNextRelease({
        upstreamReleases: [],
        registryVersions: [],
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision).toEqual({ outcome: "publish", version: "2.28.0" });
    });

    test("skips versions already on the registry and ascends to the next", () => {
      const decision = decideNextRelease({
        upstreamReleases: [],
        registryVersions: committedBackfill.slice(0, 12),
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision).toEqual({
        outcome: "publish",
        version: committedBackfill[12],
      });
    });

    test("resumes at the true next missing version when the registry has gaps", () => {
      const decision = decideNextRelease({
        upstreamReleases: [],
        registryVersions: ["2.28.0", "2.29.0", "2.31.0"],
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision).toEqual({ outcome: "publish", version: "2.30.0" });
    });

    test("reports none remaining when the registry holds every backfill version", () => {
      const decision = decideNextRelease({
        upstreamReleases: [],
        registryVersions: committedBackfill,
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision).toEqual({ outcome: "caught-up" });
    });

    test("orders by semver, not string order, whatever order the list arrives in", () => {
      const decision = decideNextRelease({
        upstreamReleases: [],
        registryVersions: [],
        backfillVersions: ["2.100.0", "2.29.0"],
        backfillFloor: "2.28.0",
      });

      expect(decision).toEqual({ outcome: "publish", version: "2.29.0" });
    });

    test("never selects an upstream release below the backfill floor", () => {
      const decision = decideNextRelease({
        upstreamReleases: [{ tag: "v2.27.0", prerelease: false }],
        registryVersions: [],
        backfillVersions: ["2.28.0"],
        backfillFloor: "2.28.0",
      });

      expect(decision).toEqual({ outcome: "publish", version: "2.28.0" });
    });

    test("includes a stable upstream release beyond the backfill list head", () => {
      const decision = decideNextRelease({
        upstreamReleases: [
          { tag: "v2.100.0", prerelease: false },
          { tag: "v2.101.0", prerelease: false },
        ],
        registryVersions: committedBackfill,
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision).toEqual({ outcome: "publish", version: "2.101.0" });
    });

    test("never selects an upstream prerelease", () => {
      const decision = decideNextRelease({
        upstreamReleases: [{ tag: "v2.101.0-rc1", prerelease: true }],
        registryVersions: committedBackfill,
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision).toEqual({ outcome: "caught-up" });
    });
  });

  describe("the prerelease-flag vs tag-semver cross-check", () => {
    test("concordant flags pass and the decision computes normally", () => {
      const decision = decideNextRelease({
        upstreamReleases: [
          { tag: "v2.100.0", prerelease: false },
          { tag: "v2.101.0", prerelease: false },
          { tag: "v2.102.0-rc1", prerelease: true },
        ],
        registryVersions: committedBackfill,
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision).toEqual({ outcome: "publish", version: "2.101.0" });
    });

    test("a release flagged prerelease whose tag has no prerelease segment aborts", () => {
      const decision = decideNextRelease({
        upstreamReleases: [{ tag: "v2.101.0", prerelease: true }],
        registryVersions: committedBackfill,
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision.outcome).toBe("abort");
      if (decision.outcome === "abort") {
        expect(decision.reason).toContain("v2.101.0");
        expect(decision.reason).toContain("prerelease");
      }
    });

    test("a release flagged stable whose tag is prerelease-shaped aborts", () => {
      const decision = decideNextRelease({
        upstreamReleases: [{ tag: "v2.101.0-rc1", prerelease: false }],
        registryVersions: committedBackfill,
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision.outcome).toBe("abort");
      if (decision.outcome === "abort") {
        expect(decision.reason).toContain("v2.101.0-rc1");
      }
    });

    test("a tag that is not semver at all aborts, naming it", () => {
      const decision = decideNextRelease({
        upstreamReleases: [{ tag: "v2.10x.0", prerelease: false }],
        registryVersions: committedBackfill,
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision.outcome).toBe("abort");
      if (decision.outcome === "abort") {
        expect(decision.reason).toContain("v2.10x.0");
      }
    });

    test("a mismatch aborts even when the registry is otherwise caught up", () => {
      const decision = decideNextRelease({
        upstreamReleases: [
          { tag: "v2.100.0", prerelease: false },
          { tag: "v2.101.0-rc1", prerelease: false },
        ],
        registryVersions: [...committedBackfill, "2.101.0"],
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision.outcome).toBe("abort");
    });
  });

  describe("fail-closed on unusable data", () => {
    test("a registry version that is not semver aborts rather than risking a duplicate publish", () => {
      const decision = decideNextRelease({
        upstreamReleases: [],
        registryVersions: ["2.100.0", "not-a-version"],
        backfillVersions: committedBackfill,
        backfillFloor: "2.28.0",
      });

      expect(decision.outcome).toBe("abort");
      if (decision.outcome === "abort") {
        expect(decision.reason).toContain("not-a-version");
      }
    });

    test("a backfill entry that is not semver aborts, naming it", () => {
      const decision = decideNextRelease({
        upstreamReleases: [],
        registryVersions: [],
        backfillVersions: ["2.28.0", "2.29.o"],
        backfillFloor: "2.28.0",
      });

      expect(decision.outcome).toBe("abort");
      if (decision.outcome === "abort") {
        expect(decision.reason).toContain("2.29.o");
      }
    });

    test("a prerelease-shaped backfill entry aborts: the backfill is stable-only", () => {
      const decision = decideNextRelease({
        upstreamReleases: [],
        registryVersions: [],
        backfillVersions: ["2.28.0", "2.101.0-rc1"],
        backfillFloor: "2.28.0",
      });

      expect(decision.outcome).toBe("abort");
      if (decision.outcome === "abort") {
        expect(decision.reason).toContain("2.101.0-rc1");
      }
    });

    test("a backfill floor that is not semver aborts", () => {
      const decision = decideNextRelease({
        upstreamReleases: [],
        registryVersions: [],
        backfillVersions: committedBackfill,
        backfillFloor: "2.28",
      });

      expect(decision.outcome).toBe("abort");
      if (decision.outcome === "abort") {
        expect(decision.reason).toContain("2.28");
      }
    });
  });
});
