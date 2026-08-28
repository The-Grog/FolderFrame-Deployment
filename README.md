# FolderFrame Deployment

Caddy Docker packaging for [FolderFrame](https://github.com/The-Grog/FolderFrame).
The build fetches the app from a published stable GitHub release, not a copied snapshot.

## Update process

1. Commit and push app changes to The-Grog/FolderFrame.
2. Publish a stable GitHub Release there, using a tag such as v0.1.0.
3. The deployment workflow checks daily at 09:23 UTC. To build sooner, open Actions, select **Publish release image**, and select **Run workflow** on main.
4. After publication succeeds, pull and recreate the container on your server (or use Unraid Update once a template is configured).

Ordinary app commits, drafts and prereleases do not publish images.
If there is no stable release, the workflow reports that and exits without publishing.
Only the latest stable release is selected. GitHub schedules may be delayed and may be disabled after 60 days of repository inactivity; manual runs remain available.
No cross-repository personal token is required. The workflow uses GitHub's built-in token.
Deployment pushes run resolver tests only; publication happens through the daily or manual workflow.

## Image tags and traceability

Image repository: ghcr.io/the-grog/folderframe-deployment

- test: the most recently packaged stable release; existing test installs can keep this tag.
- The upstream release tag, e.g. v0.1.0.
- build-<app SHA prefix>-<deployment SHA prefix>: identifies the app and packaging revisions.

A packaging change can rebuild the same app release; its version and test tags then move.
For exact rollback use a recorded image digest. No latest tag is published yet.
The workflow skips a build if test already has matching app commit, release tag and deployment commit labels.
Tests must pass before tags are pushed; test is pushed last.
Grogpool is never updated automatically.

## Local builds

Prepare an upstream checkout for a published tag (replace v0.1.0 with an existing release):

```sh
git clone --depth 1 --branch v0.1.0 https://github.com/The-Grog/FolderFrame.git upstream
docker build --pull -t folderframe:test .
```

Do not run the clone command over an existing directory. Use a clean upstream checkout for each intended release.
The old local app/ snapshot, if present, is ignored and no longer used. It is retained locally, not deleted.
The upstream checkout is ignored by Git. Docker receives only the explicitly allowlisted runtime assets, including the logo and favicon.
If a future release adds runtime files, update the allowlists and Dockerfile deliberately; never copy the whole repository.

## Run on a trusted LAN

Replace the media path and choose an unused host port:

```sh
docker run -d --name folderframe-test -p 8088:8080 --mount type=bind,source=/absolute/path/to/media,target=/media,readonly ghcr.io/the-grog/folderframe-deployment:test
```

Anyone who can reach the service can download its media. Use a dedicated media directory without private files or symlinks.
Read-only protects against writes, not downloads. Do not mount a whole share or repository.
No authentication or TLS is configured; do not expose this test publicly without access controls.
No privileged mode or host networking is needed. Media is outside the image.

## Checks

`python -m unittest discover -s scripts -p 'test_*.py'` tests stable-release resolution, missing releases, API failures and invalid refs.
The image workflow validates Caddy and checks the home page, runtime assets, media listing and private-path 404 responses.
Photos, albums, video playback and slideshow were previously checked locally; the new release-based path needs its first published release to complete an end-to-end test.
The Caddy base remains pinned to the tested digest; update deliberately and retest.
