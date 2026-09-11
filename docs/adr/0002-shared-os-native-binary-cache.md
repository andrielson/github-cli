# Shared OS-native, per-version binary cache

Downloaded binaries live in an OS-native cache shared by every install of the wrapper on the machine — `$XDG_CACHE_HOME`/`~/.cache/gh-wrapper` (Linux), `~/Library/Caches/gh-wrapper` (macOS), `%LOCALAPPDATA%\gh-wrapper\Cache` (Windows) — with one subdirectory per version (`…/gh-wrapper/2.100.0/bin/gh`), rather than inside the package's install directory (the cypress/puppeteer pattern).

## Considered Options

- **Inside the package dir**: npm uninstall cleans it automatically, but each project-local install carries its own copy, nothing is shared across versions or projects, and every global version switch re-downloads.
- **Shared OS-native cache** (chosen): survives npm uninstall/reinstall, one copy per version machine-wide; costs manual cleanup, which the README documents.

## Consequences

- Concurrent installs are made safe by downloading into a unique staging directory, verifying and extracting there, then atomically renaming into place; on Windows, `EPERM`/`EEXIST` on rename-onto-existing is treated as success (the rival install placed the identical verified binary). Parallel installs may download twice; corruption is impossible.
- Orphaned versions accumulate until the user cleans the cache; the README documents how.
