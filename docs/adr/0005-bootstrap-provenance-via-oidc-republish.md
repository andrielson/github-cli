# Bootstrap publish: manual publish creates the package, then an OIDC re-publish gives the head version provenance

Status: accepted.

npm's OIDC trusted publishing can only be configured on a package that already exists — there is no pre-registration flow — and provenance attestations are generated exclusively by OIDC publishes from supported CI; a local interactive `npm publish` can never carry one, and no retroactive attestation mechanism exists. The spec nonetheless demands provenance on every published version and `latest` correct from day one. The bootstrap therefore runs as: a manual 2FA-authenticated publish of v2.100.0 from the tagged release commit (this creates the public package with `latest` correctly on 2.100.0), then the trusted publisher is registered against `.github/workflows/publish.yml` and the package is locked to "require 2FA and disallow tokens", then — still inside npm's unpublish window — v2.100.0 is unpublished and immediately re-published by dispatching `publish.yml`, which re-creates it under OIDC with the provenance attestation. `publish.yml` is the registered, reusable head-publish path (`workflow_dispatch` plus `workflow_call`); the backfill and poll workflows compose on it and register their own workflow files as additional trusted publishers.

## Considered options

- Ship the head version without provenance, accepting a one-version exception: rejected — the version is immutable once npm's unpublish window closes, so the exception would be permanent.
- Bootstrap-publish from CI with a one-off token: rejected — violates the zero-tokens invariant (no npm token or publish secret may ever exist in this repo).
- Pre-register the trusted publisher before the first publish: impossible — npm offers no pre-registration for not-yet-existing packages.

## Consequences

- There is a minutes-long window, between the manual publish and the re-publish, in which the package exists without provenance; the wizard that drives the procedure keeps it as short as an unpublish plus one workflow run.
- Re-publishing an unpublished version must happen promptly (npm's republish grace after an unpublish is short); the procedure re-publishes within minutes, never hours.
- `publish.yml`'s filename is load-bearing: the trusted-publisher registration names it, and trusted-publisher entries are immutable (rename the file and the registration must be deleted and recreated).
- Every publish after the bootstrap is OIDC-only; with tokens disallowed on the package, no credential exists to leak anywhere.
