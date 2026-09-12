# @andrielson/gh

`@andrielson/gh` delivers the official [GitHub CLI](https://cli.github.com) (`gh`) from npm. Installing it puts a `gh` command on your `PATH` that is a drop-in replacement for a native `gh` install — same official binary, same commands, same behavior in scripts, editors and CI.

The package contains **no `gh` binary of its own**. Its `gh` command is a small shim that, on first use, downloads the official binary for the package's exact version from the [cli/cli GitHub releases](https://github.com/cli/cli/releases), verifies it against the official SHA-256 checksums (a mismatch aborts the install), stores it in a per-version cache shared by every install on the machine, and re-executes it with your arguments. Every later run is served straight from the cache with no network. A failed download aborts the command cleanly — nothing is cached or executed — and the error's recovery hint names the exact command to retry: `gh install`. The package's version always equals the upstream `gh` version it delivers: `@andrielson/gh@2.100.0` ships `gh` 2.100.0.

Two supply-chain properties hold throughout:

- **Zero code runs at install time.** The package ships no lifecycle scripts at all, so installing it can never execute anything — the first `gh` command you run is the first code of ours that runs.
- **Zero runtime npm dependencies.** The shim depends only on the Node.js standard library.

## The drop-in `gh` promise

```sh
npm install --global @andrielson/gh
gh --version
```

Arguments, stdio and exit codes pass through to the real `gh` untouched, so scripts cannot tell the shim from a native binary.

## Prefetch for CI: `gh install`

The first `gh` command you run pays the download. CI and scripted setups can pay it up front instead, so the first real command starts instantly and a broken network fails the pipeline at an explicit step:

```sh
npm install --global @andrielson/gh
gh install
gh --version
```

`gh install` is a subcommand of the shim — upstream `gh` defines no `install` command. It downloads, verifies and caches the binary for the package's exact version, then exits successfully without running the binary. It is idempotent: with the binary already cached (by an earlier command or an earlier `gh install`) it is a fast no-op that touches no network, and with `GH_BINARY` set it reports that there is nothing to install and still exits successfully, so scripts can call it unconditionally. Any failure exits non-zero with nothing cached.

## Where the binary lives: the cache

Downloaded binaries live in an OS-native cache shared by every install of this package on the machine, one directory per version — the cache survives `npm uninstall`/reinstall, and switching between package versions never re-downloads a version you already have:

- **Linux**: `$XDG_CACHE_HOME/gh-wrapper` (default `~/.cache/gh-wrapper`)
- **macOS**: `~/Library/Caches/gh-wrapper`
- **Windows**: `%LOCALAPPDATA%\gh-wrapper\Cache`

Under the cache root shown for your OS, each version's binary sits at `<version>/bin/gh` (or `gh.exe` on Windows). The cache is never cleaned automatically: remove the whole directory to reclaim the space, or delete individual `<version>` directories to drop specific versions. Versions left behind by downgrades are harmless orphans.

## PATH conflicts are your responsibility

If another `gh` (from brew, scoop, apt, a manual install, …) is earlier on your `PATH`, that one wins — this package neither detects nor resolves the conflict. Check which `gh` you are getting with `command -v gh` (POSIX) or `Get-Command gh` (PowerShell).

## Binary override

Set `GH_BINARY` to the path of an existing `gh` binary and the shim executes it directly — no download, no cache, no checksum verification. Trust resides with you, who placed the binary.

## Mirror override

Set `GH_MIRROR` to a base URL and every download — the archive **and** the checksums file it is verified against — comes from `<base>/v<version>/…` instead of `https://github.com/cli/cli/releases/download/v<version>/…`. A mirror that mirrors the upstream release layout works as-is. Verification stays fail-closed against the checksums from the same mirror, which guarantees consistency with your configured source, not defense against a fully compromised one.

## Proxy support

Downloads honour the standard proxy environment variables — `https_proxy`/`HTTPS_PROXY` for `https://` downloads, `http_proxy`/`HTTP_PROXY` for `http://` ones, and `no_proxy`/`NO_PROXY` for host exclusions (`*` or a comma-separated list; an entry matches the host exactly or as a domain suffix, so `example.com` also covers `sub.example.com`) — plus npm's proxy configuration: `npm_config_https_proxy`/`npm_config_proxy` in the environment (how npm exposes its config to scripts) and `https-proxy`/`proxy` in your user `~/.npmrc`. The environment variables win over npm's configuration, and `no_proxy` exclusions apply to both sources.

Proxied downloads are fetch-first: on runtimes with Node's env-honouring proxy dispatcher (Node ≥ 22.21) the shim re-runs itself once with that mechanism engaged (`NODE_USE_ENV_PROXY=1`), and the download travels through the proxy with the same `fetch` that serves direct downloads. Where that route cannot serve — older runtimes — the download falls back to `curl`, which honours the same variables natively. For debugging exotic proxies, `GH_DOWNLOAD=curl` forces the curl route for every download. Direct downloads with no proxy configured are untouched: a plain `fetch`, as before.

## Platform detection overrides

`GH_PLATFORM` and `GH_ARCH` override the detected platform/architecture (values as Node reports them, e.g. `GH_PLATFORM=darwin GH_ARCH=arm64`). Advanced use: pre-seeding a cache for another machine. Downloading a binary that cannot execute on the current machine is on you.

## Status

Pre-release, not yet on npm. The lazy download, the `gh install` prefetch and the proxy support described above are implemented and verified against the real upstream release; cross-platform CI validation (the suite natively on all six v1 target runners, plus an Alpine/musl container job running a real install) runs on every push, and release automation lands before the first publish.
