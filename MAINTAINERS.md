# Maintainer guide

This document is for maintainers of the canonical FolderFrame deployment repository.

## Release flow

1. Commit, test, and push FolderFrame changes to `The-Grog/FolderFrame`.
2. Publish a stable GitHub release with a Docker-compatible tag such as `v0.7.0`.
3. Commit and push the reviewed deployment recipe, then manually dispatch
   **Publish release image** and complete the `container-publish` approval.
   Scheduled, push, and pull-request runs validate only; they do not publish.
4. Confirm resolver tests, image smoke tests, and GHCR publication succeed.
   The smoke test must generate and serve a WebP and persistent manifest from a read-only media mount.
5. Confirm the version tag and `stable` resolve to the expected image digest.
6. Update release notes and user-facing documentation when configuration changes.

Drafts and prereleases are intentionally ignored. If no stable release exists, the workflow exits without publishing.

## Published tags

The workflow first pushes run-scoped platform candidates and tests each by
immutable digest. It assembles and verifies their candidate index, then promotes
that digest to the traceable build tag, application version tag, `test`, and
finally `stable`, verifying each promotion. Tags are updated sequentially, not
as one atomic transaction; if promotion fails, inspect every release tag before
retrying and do not report publication complete. Candidate tags are not releases.

A packaging change can rebuild an existing app release, so rollback-sensitive
users should record an image digest. Application version image tags are not
immutable packaging identifiers.

## Versioning and verified multi-architecture publication

Adding ARM64 support warrants deployment release notes, but this packaging-only
change did not require a new core application version. The workflow uses the
latest published stable core release and records both its revision and the
deployment revision. A deployment-repository tag alone does not select the app
release.

Verified publication:

- Core release: `v0.8.3` at `2b098094b9ab4d2d024d6c3c5d3263cb7e2b91a6`.
- Deployment recipe used to build the image: `110b8fa130c688f79557bc1a991ce80d35e9e8fe`.
- Workflow: [Publish release image #36217656032](https://github.com/The-Grog/FolderFrame-Deployment/actions/runs/36217656032).
- Verified multi-platform index: `sha256:387e5723778e06540f4d10d7278c98747f81dbe72f349b2ddd799d4c81914830`.
- Immutable `linux/amd64` and `linux/arm64` candidates passed smoke tests before
  the index was assembled and promoted to `build-2b098094b9ab-110b8fa130c6`,
  `v0.8.3`, `test`, and `stable`.

A 64-bit operating system is required for ARM64 Raspberry Pi use. `linux/arm/v7`
remains unsupported. Native ARM hardware performance and browser playback remain
open validation; QEMU smoke tests are not device validation. Publishing an image
does not authorize updating or restarting the production container.
## Build inputs

The workflow resolves the latest stable FolderFrame release to an immutable commit, checks it out as `upstream`, and lets Docker access only files allowlisted in `.dockerignore`. Never replace the explicit copies with `COPY .` or copy the whole application repository.

The Caddy base image is pinned by digest. Update it deliberately and rerun all tests.

## Local verification

```sh
python -m unittest discover -s scripts -p 'test_*.py'
```

For a local image build, create a clean `upstream` checkout at an existing published release tag, then run `docker build --pull -t folderframe:local .`.
This recipe requires the Apple-media core release with `vendor/heic-to-1.5.2/`
and `THIRD_PARTY_NOTICES.md`; older release inputs intentionally fail the copy
step. Coordinate the core release before publishing this recipe. Run the Linux
transcode tests with FFmpeg, and verify streaming through Caddy, client
disconnect cleanup, and source/license availability. See TRANSCODING.md.
Mount temporary sibling libraries at `/media/Library` and `/media/Archive`,
plus a separate `/config` directory. Confirm Caddy lists both libraries, the
worker creates WebPs, EXIF sidecars, `/config/folderframe-data/library.json`,
and chunk files without changing media, and video fallback can read a file in a
sibling library. Keep `/media` itself unmounted. Test all four toggle modes,
rebuild logging, and that a helper failure leaves the gallery available.

## Multi-architecture verification

The publication workflow targets exactly `linux/amd64` and `linux/arm64`. It
uses Buildx with platform-scoped caches and QEMU for ARM64 on GitHub-hosted AMD64
runners. Each platform is pushed under a run-scoped candidate tag and then smoke-tested by
its immutable digest. Only those tested digests are assembled into a candidate index;
release tags move only after that index passes platform verification. Do not publish a
partial platform set or rebuild between testing and promotion.

The pinned Caddy base digest is a manifest list containing both required
platforms. Alpine 3.23 supplies the pinned FFmpeg package plus Python and Pillow
for x86_64 and aarch64, and pillow-heif 1.5.0 supplies CPython musllinux wheels
for both. Recheck those facts whenever changing the base digest, Alpine branch,
Python version, FFmpeg pin, or pillow-heif pin.

For local/emulated checks, prepare `upstream/` at the immutable core release and
run the commands in README's Supported architectures section. A native ARM64
host should additionally run:

```sh
docker buildx build --platform linux/arm64 --load -t folderframe:native-arm64 .
scripts/smoke_container.sh folderframe:native-arm64 linux/arm64 aarch64 APP_SHA
```

Record native hardware, OS, kernel, Docker version, elapsed thumbnail/HEIF and
transcode behavior, plus browser playback results. Emulated success is not
Raspberry Pi validation. `linux/arm/v7` is deliberately out of scope because the
current release has no 32-bit dependency/build/runtime validation.

After publication, use `docker buildx imagetools inspect` and
`scripts/verify_image_index.py` as documented in README to confirm both remote
platform descriptors and that all release tags resolve to the same index digest.
## Community Apps

Keep `templates/folderframe.xml` and `ca_profile.xml` aligned with the current public contract. Run Validate and Scan in the official submission portal after meaningful XML changes.
