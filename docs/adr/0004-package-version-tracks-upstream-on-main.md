# package.json on main tracks the upstream gh stable version; every publish comes from a release commit

Status: accepted. Supersedes ADR 0003.

Mirroring means the wrapper's version is upstream's version: `main`'s `package.json` carries the current upstream stable `gh` version, and every npm publish — head or backfill — is made from a **release commit** on `main` (tagged `v<version>`) whose `package.json` equals the version being published. There is no ephemeral stamping path anywhere; recovering from a failed publish is the same loop repeated (bump → tag → publish). Upstream pre-releases are never published (`latest` is the only regular dist-tag). The current stable ships first via the manual bootstrap publish so `latest` is correct from day one; the backfill then ascends one version per manually-triggered workflow run, publishing under a transient `backfill` dist-tag, floored at v2.28.0 — the oldest version whose archive set (9 archives + checksums, macOS zip) is identical to today's, so every published version serves the full v1 target matrix.

## Considered options

- In-flight stamping (ADR 0003): rejected — `main`'s version is untruthful and no published version corresponds to a commit.
- Backfill floor at v2.66.0 (the full upstream asset set's stability point): rejected — the only change there was adding `windows_arm64.msi`, which the wrapper never downloads.
- All 204 stable versions from v0.3.5: rejected — old eras ship macOS `.tar.gz` archives and incomplete target matrices, adding variance without serving the v1 matrix.
- Auto-merged bump PRs instead of CI pushes: rejected — the repo runs without branch protection, so direct pushes by CI need no extra machinery.

## Consequences

- The backfill lands ~100 `release: <version>` commits on `main`, and the automated poll/detect workflow is deferred until the backfill completes.
- gh 0.x, 1.x and 2.0–2.27 will never resolve on npm.
- The `0.0.0-dev` pin's accidental-publish guard is obsolete: trusted publishing with zero npm tokens already prevents publishes from outside CI.
