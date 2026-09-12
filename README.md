# github-cli

Home of `@andrielson/gh` — an npm package that delivers the official GitHub CLI (`gh`) with zero runtime dependencies and zero code at install time. See [`packages/gh/README.md`](packages/gh/README.md) for the package itself.

## Repository layout

- `packages/gh/` — the publishable wrapper package: manifest, thin `bin/gh.js` executable entry, `src/` shim source (bundled to a single file by bun), and the seam-1 test suite under `tests/`.
- `release/` — release-automation decision logic: `decision.ts` is a pure module (fed by the backfill and poll workflows) computing the next missing version and the prerelease-flag vs tag-semver cross-check, with its seam-2 test suite.
- `backfill/versions.txt` — the committed list of historical stable `gh` versions to backfill to npm.
- `CONTEXT.md` — the domain glossary; `docs/adr/` — architecture decision records.

## Setup and commands

```sh
bun install
bun run build   # bundle the shim: packages/gh/src/index.ts → packages/gh/dist/shim.js
bun test        # run the test suite (rebuilds the bundle first)
```

The pre-commit hook runs Prettier over staged files and then the full test suite.

## Tests

The wrapper is tested at one black-box seam: the process boundary. The suite (`packages/gh/tests/`) spawns the real shim in a sandboxed temporary `HOME`/cache, points `GH_MIRROR` at a local fixture HTTP server that serves release archives (real tar/zip files holding a stub `gh`) and checksums files, and dispatches to stub `gh` binaries via `GH_BINARY`. It covers the first-run lazy download end-to-end, cache-hit reruns (zero network), the `gh install` prefetch subcommand, download-failure recovery hints, tampered-checksum aborts, extraction, race safety of cache population, and pass-through behavior. The shared machinery lives in `packages/gh/tests/support/harness.ts`.

The release automation is tested at a second seam: its decision logic. `release/decision.test.ts` feeds the pure `decision.ts` module fixture GitHub-API and npm-registry data — including the committed backfill list — with no network anywhere.
