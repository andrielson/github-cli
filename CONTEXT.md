# Context

Glossary for the `@andrielson/gh` wrapper effort. Definitions only — no implementation details.

## Terms

- **Wrapper package**: the npm package `@andrielson/gh`. It contains no `gh` binaries; it installs, verifies, and dispatches to a `gh` binary downloaded from the official GitHub releases of `cli/cli`.
- **Version mirroring**: the package's version always equals the upstream `gh` version it delivers (`@andrielson/gh@2.100.0` ships `gh` 2.100.0). The upstream release tag is `v`-prefixed (`v2.100.0`); the npm version is not. Mirroring is stable-only: upstream pre-releases are never published.
- **Release commit**: a commit on `main` whose `package.json` version equals the upstream stable `gh` version it publishes, tagged `v<version>` in this repo. The only source any npm version is published from.
- **Asset**: a downloadable archive attached to an upstream `gh` release (e.g. the linux amd64 `.tar.gz`). Named `gh_<version>_<OS>_<arch>.<ext>`, with `macOS` mixed-case and `linux`/`windows` lowercase.
- **Target matrix**: the set of platform/architecture combinations the wrapper supports. Initial: linux, macOS, Windows × amd64, arm64. Expansion to the full upstream asset set is intended but not yet scheduled.
- **Backfill**: the one-off publication of past stable upstream versions to npm, floored at v2.28.0 (the oldest version whose archive set matches today's), so historical `@andrielson/gh@2.x.y` installs resolve.
- **Missing version**: an upstream stable version (at or above the backfill floor) that exists upstream but not yet on the npm registry; the unit of work for the backfill and the release automation.
- **Dist-tag policy**: `latest` points only at the newest stable upstream version. A transient `backfill` dist-tag publishes historical versions during the backfill without moving `latest`.
- **Integrity policy**: every downloaded archive is verified against the official upstream `checksums.txt` (SHA-256) before extraction; verification failure aborts the install (fail-closed).
- **Shim**: the executable the wrapper puts on PATH under the name `gh`. It is not `gh` itself: it ensures the real binary is present (downloading it on first run if absent) and re-executes it with the caller's arguments.
- **Lazy download**: the policy of fetching the `gh` binary on the first invocation of any command, rather than at `npm install` time. The load-bearing path, given that npm, pnpm and Bun block dependency lifecycle scripts by default.
- **Install command**: the `gh install` subcommand (which upstream `gh` does not define): an explicit, idempotent request to fetch the package's own binary version into the cache ahead of first use, for CI and scripted setups.
- **Cache**: the wrapper's per-version store of downloaded binaries on a machine, shared by every install of the wrapper and preserved across npm uninstall/reinstall.
- **Binary override**: a user-set pointer to an existing `gh` binary; when set, the wrapper executes that binary directly — no download, no cache, no checksum verification. Trust resides with the user who placed the binary.
- **Mirror**: a user-configured alternative source for release downloads. Archives fetched from it are still checksum-verified, fail-closed, against the checksums file from the same source — guaranteeing consistency with the configured source, not defense against a fully compromised one.
- **Proxy handling**: the wrapper's rule for routing downloads through the user's proxy: the standard proxy environment variables (`https_proxy`, `http_proxy`, `no_proxy`) and npm's proxy configuration are honoured, with fetch as the first route and curl as the fallback where fetch cannot serve. Direct downloads with no proxy configured are unaffected.
