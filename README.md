# github-cli

Home of `@andrielson/gh` — an npm package that delivers the official GitHub CLI (`gh`) with zero runtime dependencies and zero code at install time. See [`packages/gh/README.md`](packages/gh/README.md) for the package itself.

## Repository layout

- `packages/gh/` — the publishable wrapper package: manifest, thin `bin/gh.js` executable entry, `src/` shim source (bundled to a single file by bun), and the seam-1 test suite under `tests/`.
- `release/` — release-automation decision logic: `decision.ts` is a pure module (fed by the backfill and poll workflows) computing the next missing version and the prerelease-flag vs tag-semver cross-check, with its seam-2 test suite.
- `backfill/versions.txt` — the committed list of historical stable `gh` versions to backfill to npm.
- `.github/workflows/ci.yml` — the CI validation matrix (see below).
- `CONTEXT.md` — the domain glossary; `docs/adr/` — architecture decision records.

## Setup and commands

```sh
bun install
bun run build   # bundle the shim: packages/gh/src/index.ts → packages/gh/dist/shim.js
bun test        # run the test suite (rebuilds the bundle first)
```

The pre-commit hook runs Prettier over staged files and then the full test suite.

## Continuous integration

Every push to `main` and every pull request runs the full suite natively on all six runners of the v1 target matrix — `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-26-intel`, `macos-26`, `windows-2025`, `windows-11-arm` — so every platform/architecture cell the wrapper claims is proven by a real run before anything publishes. Each job also asserts that the runner's real platform/architecture matches its cell, so a runner-label drift fails loudly instead of silently testing the wrong cell; any cell failure is visible per-cell and fails the workflow. A seventh job runs the same suite plus a real install-and-run of the upstream release inside an Alpine container, proving the musl story: upstream `gh` linux binaries are static (built with `CGO_ENABLED=0`), so they run on musl unchanged. The `macos-26-intel` runner line is EOL around Fall 2027; the documented fallback afterwards is running that cell on the arm64 macOS runner under Rosetta.

## Tests

The wrapper is tested at one black-box seam: the process boundary. The suite (`packages/gh/tests/`) spawns the real shim in a sandboxed temporary `HOME`/cache, points `GH_MIRROR` at a local fixture HTTP server that serves release archives (real tar/zip files holding a stub `gh`) and checksums files, routes downloads through a local stub HTTP proxy for the proxy tests, and dispatches to stub `gh` binaries via `GH_BINARY`. It covers the first-run lazy download end-to-end, cache-hit reruns (zero network), the `gh install` prefetch subcommand, download-failure recovery hints, tampered-checksum aborts, extraction, race safety of cache population, proxy handling (environment variables, `no_proxy` exclusions, npm proxy configuration, the curl fallback), and pass-through behavior. The shared machinery lives in `packages/gh/tests/support/harness.ts`.

The release automation is tested at a second seam: its decision logic. `release/decision.test.ts` feeds the pure `decision.ts` module fixture GitHub-API and npm-registry data — including the committed backfill list — with no network anywhere.
