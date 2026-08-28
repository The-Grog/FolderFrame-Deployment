# FolderFrame Deployment

Caddy-based Docker packaging for [FolderFrame](https://github.com/The-Grog/FolderFrame).
Contains only a curated public app snapshot, never a media library.

## Local build and run

Build: `docker build --pull -t folderframe:test .`

Run with an existing media folder and unused host port:

```sh
docker run -d --name folderframe-test -p 8088:8080 --mount type=bind,source=/absolute/path/to/media,target=/media,readonly folderframe:test
```

The read-only media folder is served at /photos/. Anyone who can reach the service can download its files.
Use only intended gallery content, with no private files or symlinks. Do not mount an entire share or repository.
This is a trusted-LAN HTTP test: no authentication or TLS is configured. Do not expose it publicly without access controls.
No privileged mode or host networking is needed.

## Publish a test image

In Actions, select **Publish test image**, then **Run workflow** on main.
The manual workflow builds for linux/amd64 and checks the home page, logo, listing and private-path 404s before pushing to GHCR.
It uses the built-in GITHUB_TOKEN; no personal token belongs in this repository.

Image: `ghcr.io/the-grog/folderframe-deployment:test`
Each build also receives a `sha-<commit>` tag. No latest/production release is published.
After the first run, check the package visibility: a public repository does not automatically make its GHCR package public.

## Maintain the snapshot

Refresh only the allowlisted app files from FolderFrame source, including docs/images/folderframe-logo.png, then rebuild and test.
Source changes do not automatically update this copy.
Both ignore files use explicit allowlists. Never force-add test-media or private files.
The Caddy base is pinned to the digest used for the initial Grogpool build; update it deliberately and retest.

## Verification status

The user verified photos, subfolders, video playback and slideshow locally on Grogpool.
The GitHub workflow still needs its first run. Video range requests, Last-Modified headers and restart behavior need additional verification.
