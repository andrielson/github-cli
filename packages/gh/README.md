# @andrielson/gh

`@andrielson/gh` delivers the official [GitHub CLI](https://cli.github.com) (`gh`) from npm. Installing it puts a `gh` command on your `PATH` that is a drop-in replacement for a native `gh` install — same official binary, same commands, same behavior in scripts, editors and CI.

The package contains **no `gh` binary of its own**. Its `gh` command is a small shim that, on first use, downloads the official binary for the package's exact version from the [cli/cli GitHub releases](https://github.com/cli/cli/releases), verifies it against the official SHA-256 checksums (a mismatch aborts the install), stores it in a per-version cache shared by every install on the machine, and re-executes it with your arguments. The package's version always equals the upstream `gh` version it delivers: `@andrielson/gh@2.100.0` ships `gh` 2.100.0.

Two supply-chain properties hold throughout:

- **Zero code runs at install time.** The package ships no lifecycle scripts at all, so installing it can never execute anything — the first `gh` command you run is the first code of ours that runs.
- **Zero runtime npm dependencies.** The shim depends only on the Node.js standard library.

## The drop-in `gh` promise

```sh
npm install --global @andrielson/gh
gh --version
```

Arguments, stdio and exit codes pass through to the real `gh` untouched, so scripts cannot tell the shim from a native binary.

## PATH conflicts are your responsibility

If another `gh` (from brew, scoop, apt, a manual install, …) is earlier on your `PATH`, that one wins — this package neither detects nor resolves the conflict. Check which `gh` you are getting with `command -v gh` (POSIX) or `Get-Command gh` (PowerShell).

## Binary override

Set `GH_BINARY` to the path of an existing `gh` binary and the shim executes it directly — no download, no cache, no checksum verification. Trust resides with you, who placed the binary.

## Status

Pre-release. The lazy download described above is not implemented yet — today the shim dispatches only to `GH_BINARY`. The first npm publish lands once the download path, cross-platform CI validation and release automation are complete.
