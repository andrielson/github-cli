# Research: CI validation matrix for the six v1 targets

- **Ticket:** [CI validation matrix for the six targets](https://github.com/Andrielson/github-cli/issues/5)
- **Researched:** 2026-09-09 (all runner facts verified against primary sources on this date)
- **Scope:** Which GitHub Actions runner labels can run install-and-run tests for the v1 target matrix (linux/macOS/windows × amd64/arm64), and whether the upstream `gh` linux binary is glibc-bound or static (musl/Alpine compatibility).

## Answer at a glance

All six v1 targets have a **native, free, GitHub-hosted runner** for this public repo today. Recommended matrix:

| Target (OS/arch) | Recommended `runs-on` label                            | Runner class                   | Status as of 2026-09-09                                                                         |
| ---------------- | ------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| linux/amd64      | `ubuntu-24.04` (`ubuntu-latest` = 24.04 today)         | Standard, 4 vCPU / 16 GB       | GA                                                                                              |
| linux/arm64      | `ubuntu-24.04-arm`                                     | Standard, 4 vCPU / 16 GB       | GA since 2025-08-07; free for public repos since 2025-01-16 (preview)                           |
| macOS/amd64      | `macos-26-intel` (fallback: `macos-15-intel`)          | Standard, 4 vCPU Intel / 14 GB | GA (`macos-13` retired 2025-12-04; whole Intel line EOL ~Fall 2027 — plan the Rosetta fallback) |
| macOS/arm64      | `macos-26` (`macos-latest` = macOS 26 arm64 today)     | Standard, 3 vCPU M1 / 7 GB     | GA since 2026-02-26                                                                             |
| windows/amd64    | `windows-2025` (`windows-latest` = windows-2025 today) | Standard, 4 vCPU / 16 GB       | GA                                                                                              |
| windows/arm64    | `windows-11-arm`                                       | Standard, 4 vCPU / 16 GB       | GA since 2025-08-07; free for public repos since 2025-04-14 (preview)                           |

And the musl fact: **the upstream `gh` linux binaries are fully static (not glibc-bound), so Alpine/musl works** — verified three independent ways, below.

## The musl fact: static, not glibc-bound

Three independent proofs, all against the actual artifacts and build config (primary sources):

1. **ELF inspection of the release artifacts.** Downloaded `gh_2.100.0_linux_amd64.tar.gz` and `gh_2.100.0_linux_arm64.tar.gz` from the [v2.100.0 release](https://github.com/cli/cli/releases/tag/v2.100.0), SHA-256 verified against `gh_2.100.0_checksums.txt`, then inspected:
   - `file` reports `ELF 64-bit LSB executable ... statically linked` for **both** amd64 and arm64.
   - `readelf --program-headers` shows **no `PT_INTERP`** segment and `readelf --dynamic` shows **no `NEEDED`** entries on either binary — there is no dynamic loader or shared-library dependency at all.
   - `ldd` prints `not a dynamic executable`.
2. **Runtime proof on musl.** Inside `docker run --rm alpine:latest` (x86_64, musl libc), the amd64 binary runs: `gh version 2.100.0 (2026-09-03)`. No glibc present in the container.
3. **Upstream build config.** cli/cli's [`.goreleaser.yml` at trunk](https://github.com/cli/cli/blob/trunk/.goreleaser.yml) builds the linux block (goos `linux`, goarch `386`/`arm`/`amd64`/`arm64`) with `CGO_ENABLED=0`, which produces pure-Go static binaries (including the pure-Go DNS resolver that reads `/etc/resolv.conf` directly — works fine on musl).

The arm64 ELF was inspected rather than executed (this research host lacks qemu binfmt for emulated containers), but static linkage of the arm64 binary is established by the ELF headers themselves, and the goreleaser config applies `CGO_ENABLED=0` to all linux arches uniformly.

Implications for the wrapper:

- The linux download path has **no libc dependency** to detect or branch on; glibc, musl, and even no-libc environments are all fine.
- CI can additionally smoke-test linux targets inside containers (`alpine:latest` for musl, `ubuntu:24.04`/`debian:stable` for glibc) on any `ubuntu-24.04` job — no special runner needed for the musl check.

## Runner facts as of 2026-09-09

Primary sources: the [actions/runner-images available-images table](https://github.com/actions/runner-images#available-images) (fetched 2026-09-09) and the [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), cross-checked with GitHub changelog posts (dates below).

### Linux

- `ubuntu-24.04` (x64) is GA and what `ubuntu-latest` points to. `ubuntu-22.04` and `ubuntu-22.04-arm` still exist but are older-generation.
- `ubuntu-26.04` / `ubuntu-26.04-arm` are in **public preview** — do not build the v1 matrix on them yet.
- **Arm64 is free**: [Linux arm64 hosted runners free in public repos (public preview), 2025-01-16](https://github.blog/changelog/2025-01-16-linux-arm64-hosted-runners-now-available-for-free-in-public-repositories-public-preview/); [GA for public repositories, 2025-08-07](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/); [also available in private repositories, 2026-01-29](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/). Label: `ubuntu-24.04-arm`.

### macOS

- `macos-latest` currently points to **macOS 26 arm64**. [macOS 26 went GA 2026-02-26](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/) with labels `macos-26` (arm64 standard), `macos-26-xlarge`, `macos-26-intel` (x64 standard) and `macos-26-large`.
- **Intel-mac status:** `macos-13` — the last long-standing Intel image — was [retired 2025-12-04](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/) (brownouts through November 2025). It was replaced by `macos-15-intel` and now `macos-26-intel`. Per the docs reference, `macos-15-intel` and `macos-26-intel` are **standard** runners (4 vCPU / 14 GB) and standard runners are "free and unlimited on public repositories" — no larger-runner billing needed for the amd64 macOS leg.
- **Intel has a published end of life:** in the macOS 13 retirement announcement GitHub states Intel macOS runners go away entirely **after the macOS 15 image retires in Fall 2027** (Apple has discontinued x86_64 Macs). Budget for that now: the durable path for macOS/amd64 is running the amd64 binary under **Rosetta 2** on an arm64 runner (`arch --x86_64 ./bin/gh --version`). Rosetta 2 is available on the hosted arm64 macOS images (widely relied upon, e.g. cibuildwheel's documented flow for testing x86_64 wheels on `macos-14`+ arm64 runners).
- `macos-14` (both arches) is **deprecated**: [runner-images issue #13518](https://github.com/actions/runner-images/issues/13518) — deprecation began 2026-07-06, fully unsupported 2026-11-02. Do not adopt it.

### Windows

- `windows-2025` (x64) is GA and what `windows-latest` points to. `windows-2022` still exists.
- **Windows arm64 exists and is free for public repos:** [Windows arm64 hosted runners in public preview, 2025-04-14](https://github.blog/changelog/2025-04-14-windows-arm64-hosted-runners-now-available-in-public-preview/) with the `windows-11-arm` label (Windows 11 image); covered by the [arm64 GA announcement, 2025-08-07](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/). A `windows-11-vs2026-arm` variant also exists; plain `windows-11-arm` is the right pick for an install-and-run test (VS toolchain irrelevant here).

## Notes for the CI workflow design

- This repo is public, so every leg above is free. In private repos the same arm64 standard labels work since 2026-01-29 (macOS minutes carry a multiplier on private plans).
- Prefer **pinned version labels** (`ubuntu-24.04`, `macos-26`, `windows-2025`, ...) over `-latest` aliases so a quiet `latest` migration cannot change the test floor mid-release — the runner-images repo itself recommends pinning.
- For each leg, the test is OS-matched: install the npm package with its toolchain, let it download the target's asset, verify the checksum, and run `gh --version` expecting the mirrored version string.
- Add the container-based musl smoke test (Alpine) as a cheap extra linux job on `ubuntu-24.04`; the static-binary fact above is what makes it guaranteed-pass rather than best-effort.
- Windows arm64 and Linux arm64 runners may lack some preinstalled community tooling; the wrapper test only needs Node + shell, which the images provide.

## Sources

- Release artifacts + `checksums.txt`: <https://github.com/cli/cli/releases/tag/v2.100.0> (downloaded and inspected locally, 2026-09-09)
- Build config: <https://github.com/cli/cli/blob/trunk/.goreleaser.yml> (`CGO_ENABLED=0` for linux)
- Available images and labels: <https://github.com/actions/runner-images#available-images> (fetched 2026-09-09)
- Runner specs + free-for-public-repos table: <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
- Changelog: [Linux arm64 free (2025-01-16)](https://github.blog/changelog/2025-01-16-linux-arm64-hosted-runners-now-available-for-free-in-public-repositories-public-preview/), [Windows arm64 preview (2025-04-14)](https://github.blog/changelog/2025-04-14-windows-arm64-hosted-runners-now-available-in-public-preview/), [arm64 GA (2025-08-07)](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/), [macOS 13 retirement (2025-09-19)](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/), [arm64 in private repos (2026-01-29)](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/), [macOS 26 GA (2026-02-26)](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/)
- Deprecation issue: <https://github.com/actions/runner-images/issues/13518> (macOS 14, unsupported 2026-11-02)
- Rosetta-on-arm64 evidence: <https://cibuildwheel.pypa.io/en/v2.21.0/faq/> ("Cross-compiling" section: "On an arm64 runner, it is possible to test x86_64 wheels and both parts of a universal2 wheel using Rosetta 2 emulation.")
