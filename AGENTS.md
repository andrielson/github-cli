# github-cli

Greenfield repo (named for a planned GitHub CLI). No source code or tests exist yet — only vendored agent skills and JS tooling config. When build/test commands are established, record them here.

## Tooling

- Package manager is **bun**. Always use `bun` / `bunx`, never npm or npx.
- Pre-commit hook (husky → lint-staged) runs Prettier on staged files. `.agents/**`, `.claude/**`, and `skills-lock.json` are deliberately excluded in `.lintstagedrc`: the lockfile pins each vendored skill's content hash, and reformatting those files breaks the pins.
- No `test` or `typecheck` scripts exist yet — add them to `.husky/pre-commit` when they appear.

## Skills layout

- `.agents/skills/` is the single source of truth: skills vendored from the GitHub repo `mattpocock/skills`.
- `.claude/skills/<name>` are symlinks to `../../.agents/skills/<name>`. Edit skills only under `.agents/skills/`, never through `.claude/skills/`.
- `skills-lock.json` pins each skill's source path and content hash. Upgrade skills by re-syncing from source, not by hand-editing the lockfile or vendored files.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`Andrielson/github-cli`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical labels are used as-is: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root, created lazily by the domain skills. See `docs/agents/domain.md`.

## Conventions

- Write everything the agent produces in English, regardless of the language the user speaks in the conversation (e.g., Portuguese). This covers code, code comments, documentation and any other files added to the repo, commit messages, GitHub content created via `gh` (issues, issue comments, pull request descriptions, review comments), written plans and design/spec documents produced before or during implementation, and any other generated artifact or written output. Only direct conversational replies in chat may mirror the user's language.
- Always use the long format for command arguments (e.g., `docker compose --file ... --project-name ...`, not `-f`/`-p`) — it is easier to read for someone unfamiliar with the options. This covers shell commands in general, including `RUN` statements in Dockerfiles and shell scripts such as `docker-entrypoint.sh` and `user-install.sh`. Where a tool has no long options (e.g., BusyBox utilities in Alpine-based images), short flags are fine — leave a comment saying so.
- In Docker Compose files, prefer the long syntax too: volumes as `type:`/`source:`/`target:` entries and ports as `target:`/`published:`, not the `- source:target` or `- host:container` shorthand.
- Prefer nested `.gitignore` files (e.g., `tests/.gitignore`) instead of including everything in the root `.gitignore`.
- Keep `README.md` current. Whenever the project is modified, check whether the README still reflects reality — objective, architecture, setup commands, tests — and update it in the same change whenever it does not.
