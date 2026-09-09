# github-cli

Greenfield repo (named for a planned GitHub CLI). No source code, build tooling, or tests exist yet — only vendored agent skills. When build/lint/test commands are established, record them here.

## Skills layout

- `.agents/skills/` is the single source of truth: skills vendored from the GitHub repo `mattpocock/skills`.
- `.claude/skills/<name>` are symlinks to `../../.agents/skills/<name>`. Edit skills only under `.agents/skills/`, never through `.claude/skills/`.
- `skills-lock.json` pins each skill's source path and content hash. Upgrade skills by re-syncing from source, not by hand-editing the lockfile or vendored files.

## Tracker-dependent skills need setup first

`to-spec`, `to-tickets`, `triage`, and `wayfinder` publish to a configured issue tracker, and `domain-modeling` expects domain docs (`CONTEXT.md`, `docs/adr/`). That configuration is created by the `setup-matt-pocock-skills` skill, which has not been run yet. Run it once before first use of those skills.
