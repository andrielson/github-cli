# Version stamping in CI; the registry is the source of truth

The repo never carries a real package version: `package.json` on `main` stays pinned at `0.0.0-dev`, and the publish workflow stamps the actual version into `src/version.ts` and `package.json` in an ephemeral checkout right before `npm publish`. The npm registry — not git history — is the single source of truth for which versions exist.

## Considered Options

A bump commit per version (git history mirroring npm versions) was rejected: the backfill alone would add 200+ noise commits, and it would require giving a bot write access to `main`. OIDC provenance already ties every tarball to the workflow run that built it, and tarballs remain reproducible (any checkout + the version stamp reconstructs the same package).
