# Maintainer guide

This document is for maintainers of the canonical FolderFrame deployment repository.

## Release flow

1. Commit, test, and push FolderFrame changes to `The-Grog/FolderFrame`.
2. Publish a stable GitHub release with a Docker-compatible tag such as `v0.7.0`.
3. Run **Publish release image** manually for an immediate build, or wait for the daily check.
4. Confirm resolver tests, image smoke tests, and GHCR publication succeed.
   The smoke test must generate and serve a WebP and persistent manifest from a read-only media mount.
5. Confirm the version tag and `stable` resolve to the expected image digest.
6. Update release notes and user-facing documentation when configuration changes.

Drafts and prereleases are intentionally ignored. If no stable release exists, the workflow exits without publishing.

## Published tags

The workflow pushes the version tag, a traceable build tag, `test`, and finally `stable`. A packaging change can rebuild an existing app release, so rollback-sensitive users should record an image digest.

## Build inputs

The workflow resolves the latest stable FolderFrame release to an immutable commit, checks it out as `upstream`, and lets Docker access only files allowlisted in `.dockerignore`. Never replace the explicit copies with `COPY .` or copy the whole application repository.

The Caddy base image is pinned by digest. Update it deliberately and rerun all tests.

## Local verification

```sh
python -m unittest discover -s scripts -p 'test_*.py'
```

For a local image build, create a clean `upstream` checkout at an existing published release tag, then run `docker build --pull -t folderframe:local .`.
Mount separate temporary `/media` and `/config` directories and confirm the
worker creates a WebP, `/config/folderframe-data/library.json`, and chunk
files without changing media. Test all four toggle modes, rebuild logging, and
that a helper failure leaves the gallery available.

## Community Apps

Keep `templates/folderframe.xml` and `ca_profile.xml` aligned with the current public contract. Run Validate and Scan in the official submission portal after meaningful XML changes.
