# github-cli

Home of `@andrielson/gh` — an npm package that delivers the official GitHub CLI (`gh`) with zero runtime dependencies and zero code at install time. See [`packages/gh/README.md`](packages/gh/README.md) for the package itself.

## Repository layout

- `packages/gh/` — the publishable wrapper package: manifest, thin `bin/gh.js` executable entry, `src/` shim source (bundled to a single file by bun), and the seam-1 test suite under `tests/`.
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

The wrapper is tested at one black-box seam: the process boundary. The suite (`packages/gh/tests/`) spawns the real shim in a sandboxed temporary `HOME`/cache, points `GH_MIRROR` at a local fixture HTTP server (the download-source stand-in and the network canary), and dispatches to stub `gh` binaries via `GH_BINARY`. The shared machinery lives in `packages/gh/tests/support/harness.ts`.
