# Lazy download is the load-bearing install path; no lifecycle scripts

npm v12, pnpm 10 and Bun all block dependency lifecycle scripts by default, so a postinstall download would run only where users explicitly opt in — a mostly-dead optimization that adds code-at-install-time attack surface to a package whose whole value proposition is trustworthy delivery of a binary. We therefore ship no `scripts` section at all: the first invocation of any command lazily downloads, verifies and extracts the `gh` binary, and an intercepted `gh install` subcommand (upstream `gh` defines no `install` command) provides the explicit, idempotent prefetch for CI (`npm install --global @andrielson/gh && gh install && gh --version`).

## Consequences

- "This package runs zero code at install time" becomes part of the supply-chain story.
- Every first run pays the download cost; the cache (ADR 0002) is load-bearing, not an optimization.
- The shim must handle download failure gracefully on any command, with recovery hints.
