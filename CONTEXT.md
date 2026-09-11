# Context

Glossary for the `@andrielson/gh` wrapper effort. Definitions only — no implementation details.

## Terms

- **Wrapper package**: the npm package `@andrielson/gh`. It contains no `gh` binaries; it installs, verifies, and dispatches to a `gh` binary downloaded from the official GitHub releases of `cli/cli`.
- **Version mirroring**: the package's version always equals the upstream `gh` version it delivers (`@andrielson/gh@2.100.0` ships `gh` 2.100.0). The upstream release tag is `v`-prefixed (`v2.100.0`); the npm version is not.
- **Asset**: a downloadable archive attached to an upstream `gh` release (e.g. the linux amd64 `.tar.gz`). Named `gh_<version>_<OS>_<arch>.<ext>`, with `macOS` mixed-case and `linux`/`windows` lowercase.
- **Target matrix**: the set of platform/architecture combinations the wrapper supports. Initial: linux, macOS, Windows × amd64, arm64. Expansion to the full upstream asset set is intended but not yet scheduled.
- **Backfill**: the one-off publication of all past stable upstream versions to npm, so any historical `@andrielson/gh@2.x.y` install resolves.
- **Dist-tag policy**: `latest` points only at stable upstream versions; upstream pre-releases (e.g. `-rc1`) are published as npm pre-releases under the `next` dist-tag.
- **Integrity policy**: every downloaded archive is verified against the official upstream `checksums.txt` (SHA-256) before extraction; verification failure aborts the install (fail-closed).
- **Shim**: the executable the wrapper puts on PATH under the name `gh`. It is not `gh` itself: it ensures the real binary is present (downloading it on first run if absent) and re-executes it with the caller's arguments.
- **Lazy download**: the policy of fetching the `gh` binary on the first invocation of any command, rather than at `npm install` time. The load-bearing path, given that npm, pnpm and Bun block dependency lifecycle scripts by default.
- **Install command**: the `gh install` subcommand (which upstream `gh` does not define): an explicit, idempotent request to fetch the package's own binary version into the cache ahead of first use, for CI and scripted setups.
- **Cache**: the wrapper's per-version store of downloaded binaries on a machine, shared by every install of the wrapper and preserved across npm uninstall/reinstall.
- **Binary override**: a user-set pointer to an existing `gh` binary; when set, the wrapper executes that binary directly — no download, no cache, no checksum verification. Trust resides with the user who placed the binary.
- **Mirror**: a user-configured alternative source for release downloads. Archives fetched from it are still checksum-verified, fail-closed, against the checksums file from the same source — guaranteeing consistency with the configured source, not defense against a fully compromised one.
